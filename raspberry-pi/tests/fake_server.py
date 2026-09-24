"""テスト用の端末 API サーバー（標準ライブラリの http.server のみを使う）。

config（ETag/If-None-Match による 304）、media/bundles（Range 対応）、
heartbeat/logs/media-failures の受信記録を提供する。
"""

from __future__ import annotations

import hashlib
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


class FakeDeviceServer:
    def __init__(self, *, expected_token: str = "test-token") -> None:
        self.expected_token = expected_token
        self.config: dict[str, Any] | None = None
        self.config_etag: str | None = None
        self.media: dict[str, bytes] = {}
        self.bundles: dict[str, bytes] = {}
        self.heartbeats: list[dict[str, Any]] = []
        self.logs_received: list[dict[str, Any]] = []
        self.media_failures: list[dict[str, Any]] = []
        self.request_log: list[tuple[str, str, dict[str, str]]] = []
        self.up = True  # False にすると全リクエストで接続を落とす
        self._lock = threading.Lock()

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), self._make_handler())
        self.port = self.httpd.server_port
        self._thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def start(self) -> None:
        self._thread.start()

    def stop(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()
        self._thread.join(timeout=5)

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def set_config(self, config: dict[str, Any]) -> None:
        with self._lock:
            self.config = config
            self.config_etag = hashlib.sha256(
                json.dumps(config, sort_keys=True, ensure_ascii=False).encode("utf-8")
            ).hexdigest()

    def _make_handler(self):
        server = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
                pass

            def _check_auth(self) -> bool:
                return self.headers.get("Authorization") == f"Bearer {server.expected_token}"

            def _record(self) -> None:
                server.request_log.append((self.command, self.path, dict(self.headers.items())))

            def do_GET(self) -> None:  # noqa: N802
                self._record()
                if not server.up:
                    self.close_connection = True
                    return
                if not self._check_auth():
                    self.send_response(401)
                    self.end_headers()
                    return
                if self.path == "/api/device/config":
                    self._handle_config()
                    return
                if self.path.startswith("/api/device/media/"):
                    key = self.path.rsplit("/", 1)[-1]
                    self._handle_blob(server.media.get(key))
                    return
                if self.path.startswith("/api/device/bundles/"):
                    key = self.path.rsplit("/", 1)[-1]
                    self._handle_blob(server.bundles.get(key))
                    return
                self.send_response(404)
                self.end_headers()

            def _handle_config(self) -> None:
                with server._lock:
                    config = server.config
                    etag = server.config_etag
                if config is None:
                    self.send_response(404)
                    self.end_headers()
                    return
                inm = self.headers.get("If-None-Match")
                if inm and etag and inm == etag:
                    self.send_response(304)
                    self.send_header("ETag", etag)
                    self.send_header("Content-Length", "0")
                    self.end_headers()
                    return
                body = json.dumps(config, ensure_ascii=False).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                if etag:
                    self.send_header("ETag", etag)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def _handle_blob(self, data: bytes | None) -> None:
                if data is None:
                    self.send_response(404)
                    self.end_headers()
                    return
                total = len(data)
                range_header = self.headers.get("Range")
                if range_header:
                    spec = range_header.replace("bytes=", "")
                    start_s, _, end_s = spec.partition("-")
                    start = int(start_s) if start_s else 0
                    if start >= total:
                        self.send_response(416)
                        self.send_header("Content-Range", f"bytes */{total}")
                        self.send_header("Content-Length", "0")
                        self.end_headers()
                        return
                    end = int(end_s) if end_s else total - 1
                    chunk = data[start : end + 1]
                    self.send_response(206)
                    self.send_header("Content-Range", f"bytes {start}-{end}/{total}")
                    self.send_header("Content-Length", str(len(chunk)))
                    self.end_headers()
                    self.wfile.write(chunk)
                    return
                self.send_response(200)
                self.send_header("Content-Length", str(total))
                self.end_headers()
                self.wfile.write(data)

            def do_POST(self) -> None:  # noqa: N802
                self._record()
                if not server.up:
                    self.close_connection = True
                    return
                if not self._check_auth():
                    self.send_response(401)
                    self.end_headers()
                    return
                length = int(self.headers.get("Content-Length", 0) or 0)
                raw = self.rfile.read(length) if length else b""
                try:
                    payload = json.loads(raw.decode("utf-8")) if raw else {}
                except ValueError:
                    payload = {}

                if self.path == "/api/device/heartbeat":
                    server.heartbeats.append(payload)
                elif self.path == "/api/device/logs":
                    server.logs_received.append(payload)
                elif self.path == "/api/device/media-failures":
                    server.media_failures.append(payload)
                else:
                    self.send_response(404)
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header("Content-Length", "0")
                self.end_headers()

        return Handler
