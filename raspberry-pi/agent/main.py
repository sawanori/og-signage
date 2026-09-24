"""Agent の起動エントリ。

同期・ダウンロード・Heartbeat・ローカルログ送信・ローカル表示サーバー・再生・監視の
各スレッドを起動して配線する（task_020・task_021）。
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
from . import platform as platform_module
from . import player as player_module
from . import schedule as schedule_module
from . import server as server_module
from . import sync as sync_module
from . import watchdog as watchdog_module

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

    clock = platform_module.SystemClock()
    plat = platform_module.RealPlatform(gen.state_dir / "mpv-ipc")

    def config_provider() -> dict | None:
        version = gen.current_version()
        if version is None:
            return None
        try:
            return gen.load_config(version)
        except (OSError, ValueError):
            return None

    def media_path_resolver(sha256: str) -> Path | None:
        path = gen.media_path(sha256)
        return path if path.is_file() else None

    def time_synced_provider() -> bool:
        return bool(heartbeat_module.get_time_synced())

    def schedule_provider() -> list[schedule_module.ScheduleEntry]:
        config = config_provider()
        return schedule_module.parse_schedule((config or {}).get("schedule"))

    # server と player は互いを必要とする（server はフェード確認 ack を player へ、
    # player は状態遷移の通知を server の broadcaster へ渡し、server は新規 SSE 接続時に
    # player の現在状態を取得する）ため、差し替え可能な間接呼び出しでこの循環を解く。
    ack_forward = {"handler": lambda transition_id, phase: None}
    state_forward = {"handler": lambda: []}

    local_server = server_module.LocalServer(
        gen,
        clock,
        port=cfg.local_server_port,
        on_ack=lambda transition_id, phase: ack_forward["handler"](transition_id, phase),
        on_log=on_log,
        current_state_provider=lambda: state_forward["handler"](),
    )

    def on_media_failure(payload: dict) -> None:
        try:
            client.post_media_failure(payload)
        except api_module.ApiError:
            logger.warning("media-failures送信に失敗しました")

    player = player_module.Player(
        plat,
        clock,
        gen.state_dir,
        config_provider=config_provider,
        media_path_resolver=media_path_resolver,
        time_synced_provider=time_synced_provider,
        notify=local_server.broadcaster.publish,
        on_media_failure=on_media_failure,
        on_log=on_log,
    )
    ack_forward["handler"] = player.handle_ack
    state_forward["handler"] = player.current_state_events

    watchdog = watchdog_module.Watchdog(
        plat,
        clock,
        gen,
        ack_monotonic_provider=local_server.last_ack_monotonic,
        on_log=on_log,
    )

    hb = heartbeat_module.HeartbeatSender(
        client,
        gen,
        agent_version=cfg.agent_version,
        interval_seconds=cfg.heartbeat_interval_seconds,
        pending_version_provider=lambda: sync_engine.pending_version,
        player_status_provider=player.status_for_heartbeat,
        on_log=on_log,
    )
    return (
        gen,
        client,
        downloader,
        sync_engine,
        hb,
        log_store,
        local_server,
        player,
        watchdog,
        schedule_provider,
        time_synced_provider,
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Share House Signage Pi Agent")
    parser.add_argument("--config", type=Path, default=DEFAULT_CONFIG_PATH)
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

    cfg = config_module.load_config(args.config)
    (
        gen,
        client,
        downloader,
        sync_engine,
        hb,
        log_store,
        local_server,
        player,
        watchdog,
        schedule_provider,
        time_synced_provider,
    ) = build_components(cfg)

    applied = gen.ensure_valid_current()
    if applied is None:
        logger.warning("有効な世代がまだありません。初回同期を待ちます。")
    else:
        logger.info("起動時の適用世代: version=%s", applied)

    downloader.start()
    sync_engine.start()
    hb.start()
    local_server.start()
    player.start()
    watchdog.start(schedule_provider=schedule_provider, time_synced_provider=time_synced_provider)

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
        player.stop()
        watchdog.stop()
        local_server.stop()

    return 0


if __name__ == "__main__":
    sys.exit(main())
