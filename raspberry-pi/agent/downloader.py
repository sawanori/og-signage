"""別スレッドで動くダウンローダ。

一時ファイル（`<target>.part`）へ Range 再開つきで取得し、SHA-256 照合・fsync の後に
`os.replace` で内容アドレスの最終パスへ配置する。3 回不一致が続いたら
`state/quarantine/` へ隔離し、`POST /api/device/media-failures` で報告して、
以後はそのファイルの再取得を行わない。
"""

from __future__ import annotations

import dataclasses
import hashlib
import json
import logging
import os
import queue
import shutil
import threading
import time
from pathlib import Path
from typing import TYPE_CHECKING, Callable

from . import api as api_module

if TYPE_CHECKING:
    from . import generations as generations_module

logger = logging.getLogger(__name__)

CHUNK_SIZE = 1024 * 1024
MAX_ATTEMPTS = 3


@dataclasses.dataclass(frozen=True)
class DownloadJob:
    kind: str  # "media" | "bundle"
    key: str  # media: sha256 / bundle: bundleId
    sha256: str
    size: int
    # POST /api/device/media-failures の mediaId（lib/validators.ts の mediaFailuresSchema）。
    # media のみ設定される。bundle の隔離報告は key（= bundleId）をそのまま使う。
    media_id: str | None = None


class Downloader:
    def __init__(
        self,
        client: api_module.DeviceApiClient,
        gen: "generations_module.GenerationManager",
        *,
        max_attempts: int = MAX_ATTEMPTS,
        on_job_done: Callable[[], None] | None = None,
        on_log: Callable[[str, str], None] | None = None,
    ) -> None:
        self._client = client
        self._gen = gen
        self._max_attempts = max_attempts
        self._on_job_done = on_job_done
        self._on_log = on_log or (lambda level, msg: None)

        self._queue: "queue.Queue[DownloadJob | None]" = queue.Queue()
        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()
        self._lock = threading.Lock()

        self._quarantine_dir = self._gen.state_dir / "quarantine"
        self._attempts_dir = self._gen.state_dir / "download_attempts"
        self._quarantine_dir.mkdir(parents=True, exist_ok=True)
        self._attempts_dir.mkdir(parents=True, exist_ok=True)

    def set_on_job_done(self, callback: Callable[[], None] | None) -> None:
        self._on_job_done = callback

    # ---- 公開 API ----
    def enqueue(self, job: DownloadJob) -> None:
        if self.is_quarantined(job.key):
            return
        self._queue.put(job)

    def start(self) -> None:
        if self._thread is not None:
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, name="downloader", daemon=True)
        self._thread.start()

    def stop(self, timeout: float | None = 5.0) -> None:
        self._stop_event.set()
        self._queue.put(None)
        if self._thread is not None:
            self._thread.join(timeout=timeout)
            self._thread = None

    def _run(self) -> None:
        while not self._stop_event.is_set():
            job = self._queue.get()
            if job is None:
                continue
            try:
                self.process(job)
            except Exception:
                logger.exception("download job failed key=%s", job.key)
                self._on_log("error", f"media取得処理で例外が発生しました key={job.key}")
            if self._on_job_done is not None:
                try:
                    self._on_job_done()
                except Exception:
                    logger.exception("on_job_done callback raised")

    # ---- 隔離台帳 ----
    def _attempts_path(self, key: str) -> Path:
        return self._attempts_dir / f"{key}.json"

    def _quarantine_marker_path(self, key: str) -> Path:
        return self._quarantine_dir / f"{key}.json"

    def is_quarantined(self, key: str) -> bool:
        return self._quarantine_marker_path(key).exists()

    def _get_attempts(self, key: str) -> int:
        p = self._attempts_path(key)
        if not p.exists():
            return 0
        try:
            return int(json.loads(p.read_text(encoding="utf-8"))["attempts"])
        except (OSError, ValueError, KeyError):
            return 0

    def _set_attempts(self, key: str, attempts: int) -> None:
        self._attempts_path(key).write_text(json.dumps({"attempts": attempts}), encoding="utf-8")

    def _clear_attempts(self, key: str) -> None:
        p = self._attempts_path(key)
        if p.exists():
            p.unlink()

    def _quarantine(self, job: DownloadJob, tmp_path: Path, reason: str) -> None:
        self._clear_attempts(job.key)
        dest = self._quarantine_dir / job.key
        try:
            if tmp_path.exists():
                if dest.exists():
                    dest.unlink()
                shutil.move(str(tmp_path), str(dest))
        except OSError:
            logger.exception("failed to move quarantined file key=%s", job.key)

        marker = {
            "kind": job.kind,
            "key": job.key,
            "sha256": job.sha256,
            "size": job.size,
            "reason": reason,  # ローカル診断用の詳細文字列（API へはそのまま送らない）
            "quarantinedAt": time.time(),
        }
        self._quarantine_marker_path(job.key).write_text(json.dumps(marker, ensure_ascii=False), encoding="utf-8")

        # lib/validators.ts の mediaFailuresSchema は mediaId / bundleId のどちらか一方を
        # 持てる。media は job.media_id、bundle は job.key（= bundleId）をそのまま送る。
        id_field: dict[str, str] | None = None
        if job.kind == "media" and job.media_id:
            id_field = {"mediaId": job.media_id}
        elif job.kind == "bundle":
            id_field = {"bundleId": job.key}

        if id_field is not None:
            payload = {
                **id_field,
                "reason": "hash_mismatch",
                "quarantined": True,
                "occurredAt": int(time.time()),
            }
            try:
                self._client.post_media_failure(payload)
            except api_module.ApiError:
                logger.exception("failed to report media failure key=%s", job.key)
        self._on_log("error", f"media隔離: key={job.key} reason={reason}")

    # ---- パス ----
    def target_path(self, job: DownloadJob) -> Path:
        if job.kind == "media":
            return self._gen.media_path(job.sha256)
        return self._gen.bundle_archive_path(job.key)

    def tmp_path(self, job: DownloadJob) -> Path:
        return Path(str(self.target_path(job)) + ".part")

    # ---- 実処理 ----
    def process(self, job: DownloadJob) -> bool:
        """1 件をダウンロードする。成功なら True。

        既に隔離済みなら何もせず False（再取得を繰り返さない）。
        """
        if self.is_quarantined(job.key):
            return False

        target = self.target_path(job)
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.tmp_path(job)

        if target.is_file() and target.stat().st_size == job.size:
            return True  # 既に取得済み（内容アドレスなので一致とみなす）

        existing = tmp.stat().st_size if tmp.exists() else 0
        range_header = f"bytes={existing}-" if existing > 0 else None

        try:
            if job.kind == "media":
                resp = self._client.get_media(job.key, range_header=range_header)
            else:
                resp = self._client.get_bundle(job.key, range_header=range_header)
        except api_module.NetworkError:
            return False  # ネット不通。次回の同期サイクルに持ち越す
        except api_module.HttpError as exc:
            if exc.status == 416:
                # 再開位置がサーバー側の内容とずれている。tmp を捨てて最初から取り直す。
                tmp.unlink(missing_ok=True)
                return self.process(job)
            self._on_log("error", f"media取得がサーバーエラー: key={job.key} status={exc.status}")
            return False

        resumed = bool(range_header) and getattr(resp, "status", 200) == 206
        mode = "ab" if resumed else "wb"
        if not resumed and tmp.exists():
            tmp.unlink()

        with resp:
            with open(tmp, mode) as f:
                while True:
                    chunk = resp.read(CHUNK_SIZE)
                    if not chunk:
                        break
                    f.write(chunk)
                f.flush()
                os.fsync(f.fileno())

        actual_size = tmp.stat().st_size
        if actual_size != job.size:
            return self._handle_mismatch(job, tmp, f"size mismatch: got {actual_size}, expected {job.size}")

        actual_sha256 = self._sha256_of(tmp)
        if actual_sha256 != job.sha256:
            return self._handle_mismatch(
                job, tmp, f"sha256 mismatch: got {actual_sha256}, expected {job.sha256}"
            )

        os.replace(tmp, target)
        self._clear_attempts(job.key)
        return True

    def _handle_mismatch(self, job: DownloadJob, tmp: Path, reason: str) -> bool:
        attempts = self._get_attempts(job.key) + 1
        if attempts >= self._max_attempts:
            self._quarantine(job, tmp, reason)
            return False
        self._set_attempts(job.key, attempts)
        tmp.unlink(missing_ok=True)
        self._on_log("warning", f"media不一致({attempts}/{self._max_attempts}): key={job.key} reason={reason}")
        return False

    @staticmethod
    def _sha256_of(path: Path) -> str:
        h = hashlib.sha256()
        with open(path, "rb") as f:
            for chunk in iter(lambda: f.read(CHUNK_SIZE), b""):
                h.update(chunk)
        return h.hexdigest()
