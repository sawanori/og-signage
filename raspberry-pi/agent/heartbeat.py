"""別スレッドで 60 秒ごとに Heartbeat を送る（25 節 / 実装計画 9 節）。

`lib/validators.ts` の `heartbeatSchema`（コミット 196488e で確定）は
`mode`・`displayHealthy`・`timeSynced`・`diskFreeBytes` を null 不可の必須項目として
要求する。この Agent（同期・世代・ダウンロード層）が直接取得できるのは
`agentVersion, bundleId, appliedVersion, pendingVersion, timeSynced,
diskFreeBytes, cpuTempC, memAvailableBytes` で、`mode, displayHealthy,
nextVideoAt, lastVideoFinishedAt` は表示・再生を担当する player（task_021）の値。

player がまだ無い間もスキーマを満たせるよう、既定の `player_status_provider` は
`mode="off"`（表示時間外相当）・`displayHealthy=False`（未確認）・
`nextVideoAt=None`・`lastVideoFinishedAt=None` を返す。player.py 完成後は
`player_status_provider` を実値を返す関数に差し替える。
"""

from __future__ import annotations

import logging
import re
import shutil
import subprocess
import threading
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable, Protocol

from . import api as api_module

if TYPE_CHECKING:
    from . import generations as generations_module

logger = logging.getLogger(__name__)

DEFAULT_HEARTBEAT_INTERVAL_SECONDS = 60.0

_THERMAL_ZONE_PATH = Path("/sys/class/thermal/thermal_zone0/temp")
_MEMINFO_PATH = Path("/proc/meminfo")


class PlayerStatusProvider(Protocol):
    def __call__(self) -> dict[str, Any]: ...


def _default_player_status() -> dict[str, Any]:
    """player.py（task_021）が未配線のときの既定値。heartbeatSchema の必須項目を満たす。"""
    return {
        "mode": "off",
        "displayHealthy": False,
        "nextVideoAt": None,
        "lastVideoFinishedAt": None,
    }


def get_time_synced() -> bool | None:
    """OS の時刻同期状態を取得する。判定できない環境では None を返す。"""
    try:
        result = subprocess.run(
            ["timedatectl", "show", "--property=NTPSynchronized", "--value"],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
        )
    except (OSError, subprocess.SubprocessError):
        return None

    value = result.stdout.strip().lower()
    if value == "yes":
        return True
    if value == "no":
        return False
    return None


def get_cpu_temp_c(path: Path = _THERMAL_ZONE_PATH) -> float | None:
    try:
        raw = path.read_text(encoding="utf-8").strip()
        return int(raw) / 1000.0
    except (OSError, ValueError):
        return None


def get_mem_available_bytes(path: Path = _MEMINFO_PATH) -> int | None:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    match = re.search(r"^MemAvailable:\s+(\d+)\s+kB", text, re.MULTILINE)
    if not match:
        return None
    return int(match.group(1)) * 1024


def get_disk_free_bytes(path: Path) -> int:
    return shutil.disk_usage(path).free


class HeartbeatSender:
    def __init__(
        self,
        client: api_module.DeviceApiClient,
        gen: "generations_module.GenerationManager",
        *,
        agent_version: str,
        interval_seconds: float = DEFAULT_HEARTBEAT_INTERVAL_SECONDS,
        pending_version_provider: Callable[[], str | None] | None = None,
        bundle_id_provider: Callable[[], str | None] | None = None,
        player_status_provider: PlayerStatusProvider | None = None,
        on_log: Callable[[str, str], None] | None = None,
    ) -> None:
        self._client = client
        self._gen = gen
        self._agent_version = agent_version
        self._interval = interval_seconds
        self._pending_version_provider = pending_version_provider or (lambda: None)
        self._bundle_id_provider = bundle_id_provider or self._default_bundle_id
        self._player_status_provider = player_status_provider or _default_player_status
        self._on_log = on_log or (lambda level, msg: None)

        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()

    def _default_bundle_id(self) -> str | None:
        version = self._gen.current_version()
        if version is None:
            return None
        try:
            config = self._gen.load_config(version)
        except (OSError, ValueError):
            return None
        bundle = config.get("displayBundle") or {}
        return bundle.get("id")

    def build_payload(self) -> dict[str, Any]:
        # heartbeatSchema の timeSynced は必須の boolean（null 不可）。判定できない場合は
        # 「同期済みとは確認できていない」として False にする（安全側のデフォルト）。
        time_synced = get_time_synced()

        payload: dict[str, Any] = {
            "agentVersion": self._agent_version,
            "bundleId": self._bundle_id_provider(),
            "appliedVersion": self._gen.current_version(),
            "pendingVersion": self._pending_version_provider(),
            "timeSynced": time_synced if time_synced is not None else False,
            "diskFreeBytes": get_disk_free_bytes(self._gen.data_dir),
            "cpuTempC": get_cpu_temp_c(),
            "memAvailableBytes": get_mem_available_bytes(),
        }
        payload.update(self._player_status_provider())
        return payload

    def send_once(self) -> None:
        payload = self.build_payload()
        try:
            self._client.post_heartbeat(payload)
        except api_module.NetworkError:
            self._on_log("warning", "heartbeat送信に失敗しました（ネットワーク不通）")
        except api_module.HttpError as exc:
            self._on_log("error", f"heartbeat送信がサーバーエラーになりました: status={exc.status}")

    def start(self) -> None:
        if self._thread is not None:
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._loop, name="heartbeat", daemon=True)
        self._thread.start()

    def stop(self, timeout: float | None = 5.0) -> None:
        self._stop_event.set()
        if self._thread is not None:
            self._thread.join(timeout=timeout)
            self._thread = None

    def _loop(self) -> None:
        while not self._stop_event.is_set():
            try:
                self.send_once()
            except Exception:
                logger.exception("heartbeat loop iteration failed")
            self._stop_event.wait(self._interval)
