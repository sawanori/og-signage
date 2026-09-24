"""Pi 上のローカル HTTP サーバー（実装計画 7 節・9 節、task_021）。

`ThreadingHTTPServer` で `127.0.0.1` のみ待ち受ける。表示ページ（task_014b の `display/`）へ:

- `GET /`、その他の静的ファイル: current 世代の `displayBundle` を展開したディレクトリを配信する。
- `GET /local/config.json`: current 世代の config.json をそのまま返す。
- `GET /local/media/<sha256>`: 画像・動画の実体（Range 対応）。
- `GET /local/events`: SSE。再生状態機械の遷移と config 更新を通知する。
- `POST /local/ack`: 表示ページからの生存応答、およびフェード完了確認。

## /local/* の取り決め（表示ページ側が守ること）

- `/local/events` は Server-Sent Events。1 イベントは `data: <JSON>\\n\\n` の 1 行 JSON。
  接続直後に、現在の再生状態機械の遷移イベントと時刻同期状態イベントを 1 回ずつ送ってから
  購読を始める（表示ページの再読み込みが動画再生中に起きても、次の遷移を待たずに
  黒くなる・時刻未同期の印がすぐ出るようにするため。実装計画 8.3 節・6 節前提13）。
  - 再生状態機械の遷移: `{"transitionId": "<hex>" | null, "mode": "fading_out"|"playing"|"fading_in"|"display"|"off"}`
  - config 更新: `{"type": "config_updated", "version": "<config の version>"}`
  - 時刻同期状態: `{"type": "status", "timeSynced": true|false}`（接続直後と、状態が変わった時に送る）
  - 接続維持のための空コメント行（`: keep-alive`）が挟まることがあるので、
    `data:` で始まらない行は無視すること。
- `POST /local/ack` は表示ページがおよそ 5 秒ごとに送る生存応答。本文は `{}` でよい。
  フェード演出が完了したときは追加で `{"transitionId": <受け取った値>, "phase": "fade_out_done" | "fade_in_done"}`
  を送る（`fading_out` の演出が終わったら `fade_out_done`、`fading_in` の演出が終わったら `fade_in_done`）。
  この ack が 60 秒途絶えると watchdog が Chromium を再起動する。
"""

from __future__ import annotations

import json
import logging
import mimetypes
import queue
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable

from . import generations as generations_module
from . import platform as platform_module

logger = logging.getLogger(__name__)

DEFAULT_PORT = 8080
SSE_KEEPALIVE_SECONDS = 15.0


class EventBroadcaster:
    """`/local/events` に接続中の全クライアントへイベントを配る。"""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._subscribers: list["queue.Queue[dict[str, Any]]"] = []

    def subscribe(self) -> "queue.Queue[dict[str, Any]]":
        q: "queue.Queue[dict[str, Any]]" = queue.Queue()
        with self._lock:
            self._subscribers.append(q)
        return q

    def unsubscribe(self, q: "queue.Queue[dict[str, Any]]") -> None:
        with self._lock:
            if q in self._subscribers:
                self._subscribers.remove(q)

    def publish(self, event: dict[str, Any]) -> None:
        with self._lock:
            subscribers = list(self._subscribers)
        for q in subscribers:
            q.put(event)

    @property
    def subscriber_count(self) -> int:
        with self._lock:
            return len(self._subscribers)


def sniff_image_content_type(head: bytes) -> str:
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if head.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return "image/gif"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "image/webp"
    return "image/jpeg"  # 判定できない場合の既定値


def sniff_content_type(head: bytes) -> str:
    """先頭バイトから種別を推定する（config からの手がかりが無いときの最後の手段）。"""
    if head[4:8] == b"ftyp":
        return "video/mp4"
    if head[:4] == b"\x1aE\xdf\xa3":
        return "video/webm"
    if (
        head.startswith(b"\x89PNG\r\n\x1a\n")
        or head.startswith(b"\xff\xd8\xff")
        or head[:6] in (b"GIF87a", b"GIF89a")
        or (head[:4] == b"RIFF" and head[8:12] == b"WEBP")
    ):
        return sniff_image_content_type(head)
    return "application/octet-stream"


def _send_file_with_range(handler: BaseHTTPRequestHandler, path: Path, content_type: str) -> None:
    try:
        size = path.stat().st_size
    except OSError:
        handler.send_response(404)
        handler.end_headers()
        return

    range_header = handler.headers.get("Range")
    start, end, status = 0, size - 1, 200
    if range_header and range_header.startswith("bytes="):
        spec = range_header[len("bytes=") :]
        start_s, _, end_s = spec.partition("-")
        try:
            start = int(start_s) if start_s else 0
            end = int(end_s) if end_s else size - 1
        except ValueError:
            start, end = 0, size - 1
        if start >= size or size == 0:
            handler.send_response(416)
            handler.send_header("Content-Range", f"bytes */{size}")
            handler.send_header("Content-Length", "0")
            handler.end_headers()
            return
        end = min(end, size - 1)
        status = 206

    length = end - start + 1
    handler.send_response(status)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Accept-Ranges", "bytes")
    handler.send_header("Content-Length", str(length))
    if status == 206:
        handler.send_header("Content-Range", f"bytes {start}-{end}/{size}")
    handler.end_headers()

    if handler.command == "HEAD":
        return
    with open(path, "rb") as f:
        f.seek(start)
        remaining = length
        chunk_size = 1024 * 1024
        while remaining > 0:
            chunk = f.read(min(chunk_size, remaining))
            if not chunk:
                break
            handler.wfile.write(chunk)
            remaining -= len(chunk)


class _Server(ThreadingHTTPServer):
    daemon_threads = True  # /local/events の常駐スレッドがプロセス終了を妨げないように
    allow_reuse_address = True


class LocalServer:
    def __init__(
        self,
        gen: generations_module.GenerationManager,
        clock: platform_module.Clock,
        *,
        host: str = "127.0.0.1",
        port: int = DEFAULT_PORT,
        broadcaster: EventBroadcaster | None = None,
        on_ack: Callable[[str | None, str | None], None] | None = None,
        on_log: Callable[[str, str], None] | None = None,
        current_state_provider: Callable[[], list[dict[str, Any]]] | None = None,
    ) -> None:
        self._gen = gen
        self._clock = clock
        self._broadcaster = broadcaster or EventBroadcaster()
        self._on_ack = on_ack or (lambda transition_id, phase: None)
        self._on_log = on_log or (lambda level, msg: None)
        self._current_state_provider = current_state_provider or (lambda: [])

        self._lock = threading.Lock()
        self._last_ack_monotonic = clock.monotonic()

        self._httpd = _Server((host, port), self._make_handler())
        self.port = self._httpd.server_port
        self._thread: threading.Thread | None = None

    @property
    def broadcaster(self) -> EventBroadcaster:
        return self._broadcaster

    def last_ack_monotonic(self) -> float:
        with self._lock:
            return self._last_ack_monotonic

    def start(self) -> None:
        if self._thread is not None:
            return
        self._thread = threading.Thread(target=self._httpd.serve_forever, name="local-server", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None

    # ---- config / media の取得 ----
    def _current_config(self) -> dict[str, Any] | None:
        version = self._gen.current_version()
        if version is None:
            return None
        try:
            return self._gen.load_config(version)
        except (OSError, ValueError):
            return None

    def _bundle_root(self) -> Path | None:
        config = self._current_config()
        if not config:
            return None
        bundle = config.get("displayBundle") or {}
        bundle_id = bundle.get("id")
        if not bundle_id:
            return None
        try:
            return self._gen.ensure_bundle_extracted(bundle_id)
        except generations_module.GenerationError:
            return None

    def _guess_content_type(self, config: dict[str, Any] | None, sha256: str, path: Path) -> str:
        config = config or {}

        def matches(ref: dict[str, Any] | None) -> bool:
            return bool(ref) and ref.get("sha256") == sha256

        for item in config.get("playlist") or []:
            if matches(item):
                return "video/mp4"

        house = config.get("house") or {}
        if matches(house.get("logo")) or matches(house.get("footerImage")):
            image_marker = True
        else:
            image_marker = any(matches(e.get("image")) for e in config.get("events") or []) or any(
                matches(n.get("image")) for n in config.get("notices") or []
            )

        try:
            head = path.open("rb").read(16)
        except OSError:
            head = b""

        if image_marker:
            return sniff_image_content_type(head)
        return sniff_content_type(head)

    # ---- ハンドラ ----
    def _make_handler(self):
        ctx = self

        class Handler(BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
                pass

            def do_GET(self) -> None:  # noqa: N802
                path = self.path.split("?", 1)[0]
                if path == "/local/config.json":
                    ctx._handle_config(self)
                elif path.startswith("/local/media/"):
                    ctx._handle_media(self, path)
                elif path == "/local/events":
                    ctx._handle_events(self)
                else:
                    ctx._handle_static(self, path)

            def do_HEAD(self) -> None:  # noqa: N802
                self.do_GET()

            def do_POST(self) -> None:  # noqa: N802
                if self.path.split("?", 1)[0] == "/local/ack":
                    ctx._handle_ack(self)
                else:
                    self.send_response(404)
                    self.end_headers()

        return Handler

    def _handle_config(self, handler: BaseHTTPRequestHandler) -> None:
        config = self._current_config()
        if config is None:
            handler.send_response(404)
            handler.end_headers()
            return
        body = json.dumps(config, ensure_ascii=False).encode("utf-8")
        handler.send_response(200)
        handler.send_header("Content-Type", "application/json")
        handler.send_header("Content-Length", str(len(body)))
        handler.end_headers()
        if handler.command != "HEAD":
            handler.wfile.write(body)

    def _handle_media(self, handler: BaseHTTPRequestHandler, path: str) -> None:
        sha256 = path.rsplit("/", 1)[-1]
        media_path = self._gen.media_path(sha256)
        if not media_path.is_file():
            handler.send_response(404)
            handler.end_headers()
            return
        content_type = self._guess_content_type(self._current_config(), sha256, media_path)
        _send_file_with_range(handler, media_path, content_type)

    def _handle_static(self, handler: BaseHTTPRequestHandler, path: str) -> None:
        root = self._bundle_root()
        if root is None:
            handler.send_response(503)
            handler.end_headers()
            return
        rel = path.lstrip("/")
        if rel == "":
            rel = "index.html"
        target = (root / rel).resolve()
        try:
            target.relative_to(root.resolve())
        except ValueError:
            handler.send_response(403)
            handler.end_headers()
            return
        if not target.is_file():
            handler.send_response(404)
            handler.end_headers()
            return
        content_type, _ = mimetypes.guess_type(str(target))
        _send_file_with_range(handler, target, content_type or "application/octet-stream")

    def _handle_events(self, handler: BaseHTTPRequestHandler) -> None:
        q = self._broadcaster.subscribe()
        try:
            handler.send_response(200)
            handler.send_header("Content-Type", "text/event-stream")
            handler.send_header("Cache-Control", "no-cache")
            handler.send_header("Connection", "keep-alive")
            handler.end_headers()
            for event in self._current_state_provider():
                data = json.dumps(event, ensure_ascii=False).encode("utf-8")
                handler.wfile.write(b"data: " + data + b"\n\n")
            handler.wfile.flush()
            while True:
                try:
                    event = q.get(timeout=SSE_KEEPALIVE_SECONDS)
                except queue.Empty:
                    handler.wfile.write(b": keep-alive\n\n")
                    handler.wfile.flush()
                    continue
                data = json.dumps(event, ensure_ascii=False).encode("utf-8")
                handler.wfile.write(b"data: " + data + b"\n\n")
                handler.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, OSError):
            pass
        finally:
            self._broadcaster.unsubscribe(q)

    def _handle_ack(self, handler: BaseHTTPRequestHandler) -> None:
        length = int(handler.headers.get("Content-Length", 0) or 0)
        raw = handler.rfile.read(length) if length else b""
        try:
            payload = json.loads(raw.decode("utf-8")) if raw else {}
        except ValueError:
            payload = {}

        with self._lock:
            self._last_ack_monotonic = self._clock.monotonic()

        transition_id = payload.get("transitionId")
        phase = payload.get("phase")
        if transition_id and phase:
            try:
                self._on_ack(transition_id, phase)
            except Exception:
                logger.exception("on_ack callback failed")

        handler.send_response(200)
        handler.send_header("Content-Length", "0")
        handler.end_headers()
