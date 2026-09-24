"""クラウド API（Cloudflare Workers）との通信。

標準ライブラリ（urllib）のみを使う。`Authorization: Bearer <token>` を付け、
トークンはどの例外メッセージ・ログにも出さない。

- GET /api/device/config: If-None-Match -> 304 を扱う
- GET /api/device/media/{id}, GET /api/device/bundles/{id}: Range 対応のストリーム取得
- POST /api/device/heartbeat, /api/device/logs, /api/device/media-failures
"""

from __future__ import annotations

import dataclasses
import json
import urllib.error
import urllib.request
from http.client import HTTPResponse
from typing import Any


class ApiError(Exception):
    """API 呼び出しに関するエラー全般。"""


class NetworkError(ApiError):
    """接続自体ができなかった場合（ネット不通・タイムアウトなど）。"""


class HttpError(ApiError):
    """サーバーからエラー応答（2xx/304 以外）が返った場合。"""

    def __init__(self, status: int, message: str = ""):
        super().__init__(f"HTTP {status}: {message}")
        self.status = status
        self.message = message


@dataclasses.dataclass
class ConfigResult:
    not_modified: bool
    etag: str | None
    data: dict[str, Any] | None


class DeviceApiClient:
    """端末用 API のクライアント。トークンは保持するが出力しない。"""

    def __init__(self, base_url: str, token: str, *, timeout: float = 30.0) -> None:
        self._base_url = base_url.rstrip("/")
        self._token = token
        self._timeout = timeout

    def __repr__(self) -> str:
        return f"DeviceApiClient(base_url={self._base_url!r}, token='***')"

    __str__ = __repr__

    # ---- 内部ヘルパー ----
    def _headers(self, extra: dict[str, str] | None = None) -> dict[str, str]:
        headers = {"Authorization": f"Bearer {self._token}"}
        if extra:
            headers.update(extra)
        return headers

    def _url(self, path: str) -> str:
        return f"{self._base_url}{path}"

    def _open(self, req: urllib.request.Request) -> HTTPResponse:
        try:
            return urllib.request.urlopen(req, timeout=self._timeout)
        except urllib.error.HTTPError:
            # HTTPError は URLError のサブクラスなので、下の except より先に拾って
            # そのまま呼び出し元へ伝える（呼び出し元がステータスコードごとに解釈する）。
            raise
        except urllib.error.URLError as exc:
            raise NetworkError(str(exc.reason)) from None
        except OSError as exc:
            raise NetworkError(str(exc)) from None

    # ---- config ----
    def get_config(self, etag: str | None = None) -> ConfigResult:
        headers = self._headers()
        if etag:
            headers["If-None-Match"] = etag
        req = urllib.request.Request(self._url("/api/device/config"), headers=headers, method="GET")
        try:
            resp = self._open(req)
        except urllib.error.HTTPError as exc:
            if exc.code == 304:
                new_etag = exc.headers.get("ETag") if exc.headers else None
                exc.close()
                return ConfigResult(not_modified=True, etag=new_etag or etag, data=None)
            status = exc.code
            exc.close()
            raise HttpError(status) from None

        with resp:
            body = resp.read()
            new_etag = resp.headers.get("ETag")
            data = json.loads(body.decode("utf-8")) if body else None
        return ConfigResult(not_modified=False, etag=new_etag, data=data)

    # ---- media / bundle（ストリーム。呼び出し元が close すること） ----
    def get_media(self, media_id: str, *, range_header: str | None = None) -> HTTPResponse:
        return self._get_stream(f"/api/device/media/{media_id}", range_header)

    def get_bundle(self, bundle_id: str, *, range_header: str | None = None) -> HTTPResponse:
        return self._get_stream(f"/api/device/bundles/{bundle_id}", range_header)

    def _get_stream(self, path: str, range_header: str | None) -> HTTPResponse:
        headers = self._headers({"Range": range_header} if range_header else None)
        req = urllib.request.Request(self._url(path), headers=headers, method="GET")
        try:
            return self._open(req)
        except urllib.error.HTTPError as exc:
            status = exc.code
            exc.close()
            raise HttpError(status) from None

    # ---- 送信系 ----
    def post_heartbeat(self, payload: dict[str, Any]) -> None:
        self._post_json("/api/device/heartbeat", payload)

    def post_logs(self, entries: list[dict[str, Any]]) -> None:
        # lib/validators.ts の deviceLogsSchema: { logs: [{ type, message, createdAt }], 1〜50件 }
        self._post_json("/api/device/logs", {"logs": entries})

    def post_media_failure(self, failure: dict[str, Any]) -> None:
        # lib/validators.ts の mediaFailuresSchema:
        # { failures: [{ mediaId, reason, quarantined, occurredAt }], 1〜50件 }
        self._post_json("/api/device/media-failures", {"failures": [failure]})

    def _post_json(self, path: str, payload: dict[str, Any]) -> dict[str, Any] | None:
        body = json.dumps(payload).encode("utf-8")
        headers = self._headers({"Content-Type": "application/json"})
        req = urllib.request.Request(self._url(path), data=body, headers=headers, method="POST")
        try:
            resp = self._open(req)
        except urllib.error.HTTPError as exc:
            status = exc.code
            exc.close()
            raise HttpError(status) from None

        with resp:
            raw = resp.read()
        if not raw:
            return None
        try:
            return json.loads(raw.decode("utf-8"))
        except ValueError:
            return None
