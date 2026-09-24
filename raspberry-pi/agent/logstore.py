"""端末ログのローカル保持と、未送信分のまとめ送信。

`state/logs.jsonl` に件数上限つきで保持し、`POST /api/device/logs` へ
最大 `batch_size`（既定 50。lib/validators.ts の DEVICE_LOGS_MAX と同じ）件ずつまとめて送る。
1 件は `{type, message, createdAt}`（lib/validators.ts の deviceLogsSchema）。
送信に成功した分だけをローカルから取り除く。
"""

from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any

from . import api as api_module

DEFAULT_MAX_ENTRIES = 2000
DEFAULT_BATCH_SIZE = 50


class LogStore:
    def __init__(
        self,
        state_dir: Path,
        *,
        max_entries: int = DEFAULT_MAX_ENTRIES,
        batch_size: int = DEFAULT_BATCH_SIZE,
    ) -> None:
        self._path = Path(state_dir) / "logs.jsonl"
        self._max_entries = max_entries
        self._batch_size = batch_size
        self._lock = threading.Lock()
        self._path.parent.mkdir(parents=True, exist_ok=True)

    def append(self, level: str, message: str, *, at: float | None = None) -> None:
        created_at = int(at) if at is not None else int(time.time())
        entry = {"type": level, "message": message[:2000], "createdAt": created_at}
        with self._lock:
            entries = self._read_all()
            entries.append(entry)
            if len(entries) > self._max_entries:
                entries = entries[-self._max_entries :]
            self._write_all(entries)

    def pending_count(self) -> int:
        with self._lock:
            return len(self._read_all())

    def flush(self, client: api_module.DeviceApiClient) -> int:
        """未送信分を最大 batch_size 件送信する。送信できた件数を返す（失敗時は 0）。"""
        with self._lock:
            entries = self._read_all()
            if not entries:
                return 0
            batch = entries[: self._batch_size]

        try:
            client.post_logs(batch)
        except api_module.ApiError:
            return 0

        with self._lock:
            current = self._read_all()
            if current[: len(batch)] == batch:
                remaining = current[len(batch) :]
            else:
                # 送信中に別プロセスが書き換えた場合は安全側で送信済み分だけ除く
                remaining = [e for e in current if e not in batch]
            self._write_all(remaining)
        return len(batch)

    def _read_all(self) -> list[dict[str, Any]]:
        if not self._path.exists():
            return []
        entries: list[dict[str, Any]] = []
        with open(self._path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    entries.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
        return entries

    def _write_all(self, entries: list[dict[str, Any]]) -> None:
        tmp = self._path.with_name(self._path.name + ".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            for e in entries:
                f.write(json.dumps(e, ensure_ascii=False))
                f.write("\n")
        tmp.replace(self._path)
