"""表示ページの生存監視と復旧、Chromium の毎日の定時再起動、
表示バンドル切替後の生存確認（実装計画 7 節、task_021）。

- `/local/ack` が 60 秒途絶えたら Chromium を再起動する（`platform.restart_chromium`）。
- 再起動後も 120 秒途絶えたら Agent 自身を終了する（`platform.exit_agent`。systemd の
  `Restart=` に再起動させるため終了コードは非 0 にする）。
- Chromium は毎日 4:00 に再起動する。ただしその時点で表示スケジュール上「時間外」なら
  そのタイミングで再起動し（表示中の見た目への影響を避ける）、時間外が無い（終日表示）
  設定なら 4:00 ちょうどに再起動する。
- 表示バンドルが切り替わってから 60 秒以内に ack が来なければ `previous` 世代へ戻す。
"""

from __future__ import annotations

import logging
import threading
from typing import Callable

from . import generations as generations_module
from . import platform as platform_module
from . import schedule as schedule_module

logger = logging.getLogger(__name__)

CHROMIUM_STALL_SECONDS = 60.0
AGENT_EXIT_STALL_SECONDS = 120.0
BUNDLE_CHECK_SECONDS = 60.0
DAILY_RESTART_HOUR = 4

_UNSET = object()


class Watchdog:
    def __init__(
        self,
        platform: platform_module.Platform,
        clock: platform_module.Clock,
        gen: generations_module.GenerationManager,
        *,
        ack_monotonic_provider: Callable[[], float],
        chromium_stall_seconds: float = CHROMIUM_STALL_SECONDS,
        agent_exit_stall_seconds: float = AGENT_EXIT_STALL_SECONDS,
        bundle_check_seconds: float = BUNDLE_CHECK_SECONDS,
        daily_restart_hour: int = DAILY_RESTART_HOUR,
        on_log: Callable[[str, str], None] | None = None,
    ) -> None:
        self._platform = platform
        self._clock = clock
        self._gen = gen
        self._ack_monotonic_provider = ack_monotonic_provider
        self._chromium_stall_seconds = chromium_stall_seconds
        self._agent_exit_stall_seconds = agent_exit_stall_seconds
        self._bundle_check_seconds = bundle_check_seconds
        self._daily_restart_hour = daily_restart_hour
        self._on_log = on_log or (lambda level, msg: None)

        self._chromium_restarted_at: float | None = None
        self._last_daily_restart_date: str | None = None
        self._last_seen_bundle_id: object = _UNSET
        self._bundle_check_armed_at: float | None = None

        self._thread: threading.Thread | None = None
        self._stop_event: threading.Event | None = None

    # ---- current 世代の bundleId ----
    def _current_bundle_id(self) -> str | None:
        version = self._gen.current_version()
        if version is None:
            return None
        try:
            config = self._gen.load_config(version)
        except (OSError, ValueError):
            return None
        bundle = config.get("displayBundle") or {}
        return bundle.get("id")

    # ---- 1 サイクル分の処理 ----
    def tick(self, *, schedule: list[schedule_module.ScheduleEntry], time_synced: bool) -> None:
        now_m = self._clock.monotonic()
        now_wall = self._clock.wall_time()

        self._check_ack_liveness(now_m)
        if time_synced:
            self._check_daily_restart(now_wall, schedule, time_synced)
        self._check_bundle_rollout(now_m)

    def _check_ack_liveness(self, now_m: float) -> None:
        last_ack = self._ack_monotonic_provider()

        # 再起動後に新しい ack が届いていれば復旧したとみなし、監視状態をリセットする。
        # （このチェックを「今の無応答時間が短いか」ではなく「再起動より後の ack があるか」で
        # 行うのは、そのあと再び長時間無応答になった場合に再度検知できるようにするため。）
        if self._chromium_restarted_at is not None and last_ack > self._chromium_restarted_at:
            self._chromium_restarted_at = None

        silence = now_m - last_ack
        if silence < self._chromium_stall_seconds:
            return

        if self._chromium_restarted_at is None:
            self._platform.restart_chromium()
            self._chromium_restarted_at = now_m
            self._on_log(
                "warning",
                f"表示ページの応答が{self._chromium_stall_seconds:.0f}秒以上ないためChromiumを再起動しました",
            )
            return

        if (now_m - self._chromium_restarted_at) >= self._agent_exit_stall_seconds:
            self._on_log("error", "Chromium再起動後も表示ページの応答がないためAgentを終了します")
            self._platform.exit_agent(1)

    def _check_daily_restart(
        self, now_wall: float, schedule: list[schedule_module.ScheduleEntry], time_synced: bool
    ) -> None:
        date_key = schedule_module.tokyo_date_key(now_wall)
        if date_key == self._last_daily_restart_date:
            return

        minutes = schedule_module.tokyo_minutes_of_day(now_wall)
        currently_off = not schedule_module.is_within_display_schedule(schedule, now_wall, time_synced)
        is_target_hour = minutes == self._daily_restart_hour * 60

        if currently_off or is_target_hour:
            self._platform.restart_chromium()
            self._last_daily_restart_date = date_key
            self._on_log("info", "Chromiumの毎日の定時再起動を実行しました")

    def _check_bundle_rollout(self, now_m: float) -> None:
        current_bundle_id = self._current_bundle_id()

        if current_bundle_id != self._last_seen_bundle_id:
            if self._last_seen_bundle_id is not _UNSET and self._gen.previous_version() is not None:
                self._bundle_check_armed_at = now_m
                self._on_log("info", "表示バンドルが切り替わったため生存確認を開始します")
            self._last_seen_bundle_id = current_bundle_id

        if self._bundle_check_armed_at is None:
            return

        last_ack = self._ack_monotonic_provider()
        if last_ack > self._bundle_check_armed_at:
            self._on_log("info", "新しい表示バンドルの生存確認に成功しました")
            self._bundle_check_armed_at = None
            return

        if (now_m - self._bundle_check_armed_at) >= self._bundle_check_seconds:
            reverted = self._gen.rollback_to_previous()
            if reverted is not None:
                self._on_log(
                    "error", f"新しい表示バンドルの生存確認に失敗したためversion={reverted}へ戻しました"
                )
            self._bundle_check_armed_at = None

    # ---- スレッド制御（main.py から呼ぶ） ----
    def start(
        self,
        *,
        schedule_provider: Callable[[], list[schedule_module.ScheduleEntry]],
        time_synced_provider: Callable[[], bool],
        interval_seconds: float = 5.0,
    ) -> None:
        if self._thread is not None:
            return
        self._stop_event = threading.Event()

        def loop() -> None:
            while not self._stop_event.is_set():
                try:
                    self.tick(schedule=schedule_provider(), time_synced=time_synced_provider())
                except Exception:
                    logger.exception("watchdog tick failed")
                self._stop_event.wait(interval_seconds)

        self._thread = threading.Thread(target=loop, name="watchdog", daemon=True)
        self._thread.start()

    def stop(self, timeout: float | None = 5.0) -> None:
        if self._stop_event is not None:
            self._stop_event.set()
        if self._thread is not None:
            self._thread.join(timeout=timeout)
            self._thread = None
