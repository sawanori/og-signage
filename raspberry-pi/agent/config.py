"""Agent の設定ファイル読み込み。

API のベース URL・端末トークン・データディレクトリなどを JSON ファイルから読む。
トークンは repr / str / ログに出さない。
"""

from __future__ import annotations

import dataclasses
import json
from pathlib import Path
from typing import Any


class ConfigError(Exception):
    """設定ファイルの読み込みに失敗した場合のエラー。"""


@dataclasses.dataclass(frozen=True)
class AgentConfig:
    api_base_url: str
    device_token: str
    data_dir: Path
    sync_interval_seconds: float = 10.0
    heartbeat_interval_seconds: float = 60.0
    request_timeout_seconds: float = 30.0
    disk_reserve_bytes: int = 1024**3
    log_max_entries: int = 2000
    log_batch_size: int = 50
    agent_version: str = "0.0.0"

    def __repr__(self) -> str:  # トークンをログ・例外メッセージに出さない
        return (
            "AgentConfig(api_base_url={!r}, device_token='***', data_dir={!r}, "
            "agent_version={!r})"
        ).format(self.api_base_url, self.data_dir, self.agent_version)

    __str__ = __repr__


REQUIRED_FIELDS = ("apiBaseUrl", "deviceToken", "dataDir")


def load_config(path: Path | str) -> AgentConfig:
    """JSON 設定ファイルを読み込む。"""
    path = Path(path)
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        raise ConfigError(f"設定ファイルが見つかりません: {path}") from None
    except json.JSONDecodeError as exc:
        raise ConfigError(f"設定ファイルの形式が不正です: {exc}") from None

    if not isinstance(raw, dict):
        raise ConfigError("設定ファイルの形式が不正です: オブジェクトが必要です")

    return config_from_dict(raw)


def config_from_dict(raw: dict[str, Any]) -> AgentConfig:
    missing = [f for f in REQUIRED_FIELDS if not raw.get(f)]
    if missing:
        raise ConfigError(f"設定に必須項目がありません: {', '.join(missing)}")

    return AgentConfig(
        api_base_url=str(raw["apiBaseUrl"]),
        device_token=str(raw["deviceToken"]),
        data_dir=Path(raw["dataDir"]),
        sync_interval_seconds=float(raw.get("syncIntervalSeconds", 10.0)),
        heartbeat_interval_seconds=float(raw.get("heartbeatIntervalSeconds", 60.0)),
        request_timeout_seconds=float(raw.get("requestTimeoutSeconds", 30.0)),
        disk_reserve_bytes=int(raw.get("diskReserveBytes", 1024**3)),
        log_max_entries=int(raw.get("logMaxEntries", 2000)),
        log_batch_size=int(raw.get("logBatchSize", 50)),
        agent_version=str(raw.get("agentVersion", "0.0.0")),
    )
