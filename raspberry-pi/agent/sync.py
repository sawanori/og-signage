"""Pi Agent の同期ループ（21 節 / 実装計画 7 節）。

10 秒ごとに `GET /api/device/config` を取得し、`version` が変わっていれば
新しい世代の準備をダウンローダに依頼する。ネットワーク不通・サーバーエラー時は
現行世代を維持したまま次のサイクルへ進む。`If-None-Match` が一致すれば
サーバーは 304 を返し、この場合は何もしない。

config JSON から必要な media（画像・動画）を洗い出す処理は `extract_media_references`
の 1 か所にまとめてある。TypeScript 側 `lib/config-schema.ts` の `collectMediaRefs`
（コミット 196488e で確定）と同じ規則で、`house.logo` / `house.footerImage` /
`events[].image` / `notices[].image` / `playlist[]` から mediaId 単位で重複を除いて集める。
表示バンドル（`displayBundle`）は別枠として `build_manifest` で追加する。
"""

from __future__ import annotations

import dataclasses
import json
import logging
import threading
from typing import Any, Callable

from . import api as api_module
from . import downloader as downloader_module
from . import generations as generations_module

logger = logging.getLogger(__name__)

DEFAULT_SYNC_INTERVAL_SECONDS = 10.0


@dataclasses.dataclass(frozen=True)
class MediaReference:
    media_id: str
    sha256: str
    size: int


def _add_media_ref(refs: list[MediaReference], seen: set[str], ref: dict[str, Any] | None) -> None:
    """mediaRefSchema 形（{mediaId, sha256, size}）の参照を1件追加する。null は無視する。"""
    if not ref:
        return
    media_id = ref.get("mediaId")
    sha256 = ref.get("sha256")
    if not media_id or not sha256 or media_id in seen:
        return
    refs.append(MediaReference(media_id=media_id, sha256=sha256, size=int(ref.get("size") or 0)))
    seen.add(media_id)


def extract_media_references(config: dict[str, Any]) -> list[MediaReference]:
    """config JSON が参照する media を mediaId で重複を除いて列挙する。

    lib/config-schema.ts の `collectMediaRefs` と同じ規則:
    house.logo / house.footerImage / events[].image / notices[].image /
    spotlights[].photo・logo（メンバー紹介。2026-09-26 から） / playlist[] を集める。
    表示バンドルは対象外（build_manifest が別枠で追加する）。
    """
    refs: list[MediaReference] = []
    seen: set[str] = set()

    house = config.get("house") or {}
    _add_media_ref(refs, seen, house.get("logo"))
    _add_media_ref(refs, seen, house.get("footerImage"))

    for event in config.get("events") or []:
        _add_media_ref(refs, seen, event.get("image"))

    for notice in config.get("notices") or []:
        _add_media_ref(refs, seen, notice.get("image"))

    for spotlight in config.get("spotlights") or []:
        _add_media_ref(refs, seen, spotlight.get("photo"))
        _add_media_ref(refs, seen, spotlight.get("logo"))

    for item in config.get("playlist") or []:
        _add_media_ref(refs, seen, item)

    return refs


def build_manifest(version: str, config: dict[str, Any]) -> generations_module.Manifest:
    entries: list[generations_module.ManifestEntry] = []
    for ref in extract_media_references(config):
        entries.append(
            generations_module.ManifestEntry(
                kind="media", key=ref.sha256, sha256=ref.sha256, size=ref.size, media_id=ref.media_id
            )
        )

    bundle = config.get("displayBundle")
    if bundle:
        entries.append(
            generations_module.ManifestEntry(
                kind="bundle",
                key=str(bundle["id"]),
                sha256=str(bundle["sha256"]),
                size=int(bundle.get("size", 0)),
            )
        )

    return generations_module.Manifest(version=version, entries=tuple(entries))


class SyncEngine:
    def __init__(
        self,
        client: api_module.DeviceApiClient,
        gen: generations_module.GenerationManager,
        downloader: downloader_module.Downloader,
        *,
        interval_seconds: float = DEFAULT_SYNC_INTERVAL_SECONDS,
        on_log: Callable[[str, str], None] | None = None,
    ) -> None:
        self._client = client
        self._gen = gen
        self._downloader = downloader
        self._interval = interval_seconds
        self._on_log = on_log or (lambda level, msg: None)

        self._etag: str | None = None
        self._pending_version: str | None = None

        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()

        self._state_path = self._gen.state_dir / "sync_state.json"
        self._load_state()

    # ---- 永続状態（etag） ----
    def _load_state(self) -> None:
        if self._state_path.exists():
            try:
                data = json.loads(self._state_path.read_text(encoding="utf-8"))
                self._etag = data.get("etag")
            except (OSError, ValueError):
                self._etag = None

    def _save_state(self) -> None:
        self._state_path.write_text(json.dumps({"etag": self._etag}), encoding="utf-8")

    @property
    def pending_version(self) -> str | None:
        return self._pending_version

    # ---- スレッド制御 ----
    def start(self) -> None:
        if self._thread is not None:
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._loop, name="sync", daemon=True)
        self._thread.start()

    def stop(self, timeout: float | None = 5.0) -> None:
        self._stop_event.set()
        if self._thread is not None:
            self._thread.join(timeout=timeout)
            self._thread = None

    def _loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                self.run_once()
            except Exception:
                logger.exception("sync loop iteration failed")
                self._on_log("error", "同期処理で予期しない例外が発生しました")
            self._stop_event.wait(self._interval)

    # ---- 1 サイクル分の処理 ----
    def run_once(self) -> None:
        try:
            result = self._client.get_config(self._etag)
        except api_module.NetworkError:
            self._on_log("warning", "config取得に失敗しました（ネットワーク不通）。現行世代を維持します。")
            return
        except api_module.HttpError as exc:
            self._on_log("error", f"config取得がサーバーエラーになりました: status={exc.status}")
            return

        if result.not_modified:
            return  # 304: 変更なし

        config = result.data
        if not config:
            return

        version = config.get("version")
        if not version:
            self._on_log("error", "configにversionがありません")
            return
        version = str(version)

        self._etag = result.etag
        self._save_state()

        if version == self._gen.current_version():
            self._pending_version = None
            return  # 既に適用済み

        self._prepare_and_maybe_activate(version, config)

    def _prepare_and_maybe_activate(self, version: str, config: dict[str, Any]) -> None:
        manifest = build_manifest(version, config)

        if not self._gen.has_enough_space(manifest):
            self._pending_version = version
            self._on_log(
                "warning",
                f"空き容量が不足しているため version={version} への更新を保留します。",
            )
            return

        self._gen.write_generation(version, config, manifest)
        self._pending_version = version

        for entry in self._gen.missing_entries(manifest):
            job = downloader_module.DownloadJob(
                kind=entry.kind, key=entry.key, sha256=entry.sha256, size=entry.size, media_id=entry.media_id
            )
            self._downloader.enqueue(job)

        self.try_activate_pending()

    def try_activate_pending(self) -> bool:
        """ダウンローダの完了後に呼ぶ。保留中の世代がそろっていれば切り替える。"""
        version = self._pending_version
        if version is None:
            return False
        if not self._gen.is_generation_complete(version):
            return False
        self._gen.activate(version)
        self._pending_version = None
        self._gen.prune_unreferenced()
        self._on_log("info", f"version={version} に切り替えました")
        return True
