"""Agent の起動エントリ（最小構成）。

同期・ダウンロード・Heartbeat・ローカルログ送信の各スレッドを起動する。
mpv・ローカル表示サーバー（server.py, player.py, watchdog.py）は task_021 で追加され、
このファイルに配線される。
"""

from __future__ import annotations

import argparse
import logging
import signal
import sys
import time
from pathlib import Path
from types import FrameType

from . import api as api_module
from . import config as config_module
from . import downloader as downloader_module
from . import generations as generations_module
from . import heartbeat as heartbeat_module
from . import logstore as logstore_module
from . import sync as sync_module

logger = logging.getLogger("agent")

DEFAULT_CONFIG_PATH = Path("/etc/sharehouse-signage/agent.json")
LOG_FLUSH_INTERVAL_SECONDS = 5.0


def build_components(cfg: config_module.AgentConfig):
    gen = generations_module.GenerationManager(cfg.data_dir, reserve_bytes=cfg.disk_reserve_bytes)
    client = api_module.DeviceApiClient(cfg.api_base_url, cfg.device_token, timeout=cfg.request_timeout_seconds)
    log_store = logstore_module.LogStore(gen.state_dir, max_entries=cfg.log_max_entries, batch_size=cfg.log_batch_size)

    def on_log(level: str, message: str) -> None:
        getattr(logger, level, logger.info)(message)
        log_store.append(level, message)

    downloader = downloader_module.Downloader(client, gen, on_log=on_log)
    sync_engine = sync_module.SyncEngine(
        client, gen, downloader, interval_seconds=cfg.sync_interval_seconds, on_log=on_log
    )
    downloader.set_on_job_done(sync_engine.try_activate_pending)

    hb = heartbeat_module.HeartbeatSender(
        client,
        gen,
        agent_version=cfg.agent_version,
        interval_seconds=cfg.heartbeat_interval_seconds,
        pending_version_provider=lambda: sync_engine.pending_version,
        on_log=on_log,
    )
    return gen, client, downloader, sync_engine, hb, log_store


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Share House Signage Pi Agent")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG_PATH)
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

    cfg = config_module.load_config(args.config)
    gen, client, downloader, sync_engine, hb, log_store = build_components(cfg)

    applied = gen.ensure_valid_current()
    if applied is None:
        logger.warning("有効な世代がまだありません。初回同期を待ちます。")
    else:
        logger.info("起動時の適用世代: version=%s", applied)

    downloader.start()
    sync_engine.start()
    hb.start()

    stop_flag = {"stop": False}

    def handle_signal(signum: int, frame: FrameType | None) -> None:
        stop_flag["stop"] = True

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    try:
        while not stop_flag["stop"]:
            log_store.flush(client)
            time.sleep(LOG_FLUSH_INTERVAL_SECONDS)
    finally:
        sync_engine.stop()
        downloader.stop()
        hb.stop()

    return 0


if __name__ == "__main__":
    sys.exit(main())
