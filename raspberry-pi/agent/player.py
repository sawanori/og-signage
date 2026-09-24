"""再生の状態機械（実装計画 7 節・8.1 節、task_021）。

状態: `display -> fading_out -> playing -> fading_in -> display`（と `off`）。
各遷移に `transitionId` と期限を持つ。呼び出し側はおよそ 2 秒間隔で `tick()` を呼ぶ
（mpv の `time-pos` 監視の粒度）。正しさ自体は `platform.Clock` の経過時間で判定するため、
呼び出し間隔が多少ずれても壊れない。

mpv・Chromium・HDMI 出力制御・時計はすべて `platform.py` のインターフェース越しに呼ぶため、
実機がなくても pytest で完全に検証できる。
"""

from __future__ import annotations

import dataclasses
import json
import logging
import random
import threading
import uuid
from pathlib import Path
from typing import Any, Callable

from . import platform as platform_module
from . import schedule as schedule_module

logger = logging.getLogger(__name__)

FADE_ACK_TIMEOUT_SECONDS = 3.0
STALL_TIMEOUT_SECONDS = 10.0
OVERRUN_SECONDS = 10.0

DISPLAY = "display"
FADING_OUT = "fading_out"
PLAYING = "playing"
FADING_IN = "fading_in"
OFF = "off"


@dataclasses.dataclass
class _PlaybackContext:
    item: dict[str, Any]
    started_monotonic: float
    last_progress_monotonic: float
    last_time_pos: float | None
    handle: Any


class Player:
    def __init__(
        self,
        platform: platform_module.Platform,
        clock: platform_module.Clock,
        state_dir: Path,
        *,
        config_provider: Callable[[], dict[str, Any] | None],
        media_path_resolver: Callable[[str], Path | None],
        time_synced_provider: Callable[[], bool] | None = None,
        notify: Callable[[dict[str, Any]], None] | None = None,
        on_media_failure: Callable[[dict[str, Any]], None] | None = None,
        on_log: Callable[[str, str], None] | None = None,
    ) -> None:
        self._platform = platform
        self._clock = clock
        self._state_dir = Path(state_dir)
        self._state_dir.mkdir(parents=True, exist_ok=True)
        self._config_provider = config_provider
        self._media_path_resolver = media_path_resolver
        self._time_synced_provider = time_synced_provider or (lambda: False)
        self._notify = notify or (lambda event: None)
        self._on_media_failure = on_media_failure or (lambda failure: None)
        self._on_log = on_log or (lambda level, msg: None)

        self._lock = threading.RLock()

        started = clock.monotonic()
        self._started_monotonic = started
        self._display_window_started_monotonic: float | None = started

        self._state = DISPLAY
        self._mode_for_report = DISPLAY
        self._display_healthy = True

        self._transition_id: str | None = None
        self._transition_deadline: float | None = None
        self._transition_target_item: dict[str, Any] | None = None

        self._playback: _PlaybackContext | None = None

        self._last_video_finished_monotonic: float | None = None
        self._last_video_finished_wall: float | None = None

        self._excluded_today: set[str] = set()
        self._excluded_date_key: str | None = None

        self._position_path = self._state_dir / "playback_position.json"
        self._sequence_index, self._last_played_media_id = self._load_position()

        self._test_play_path = self._state_dir / "test_play_state.json"
        self._last_test_play_processed_at = self._load_last_test_play()

        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()

    # ---- 永続状態: 順番再生の位置 ----
    def _load_position(self) -> tuple[int, str | None]:
        if self._position_path.is_file():
            try:
                data = json.loads(self._position_path.read_text(encoding="utf-8"))
                return int(data.get("sequenceIndex", 0)), data.get("lastMediaId")
            except (OSError, ValueError):
                pass
        return 0, None

    def _save_position(self) -> None:
        data = {"sequenceIndex": self._sequence_index, "lastMediaId": self._last_played_media_id}
        self._position_path.write_text(json.dumps(data), encoding="utf-8")

    # ---- 永続状態: テスト表示（1回限り） ----
    def _load_last_test_play(self) -> int | None:
        if self._test_play_path.is_file():
            try:
                data = json.loads(self._test_play_path.read_text(encoding="utf-8"))
                value = data.get("lastProcessedAt")
                return int(value) if value is not None else None
            except (OSError, ValueError):
                pass
        return None

    def _save_last_test_play(self, value: int) -> None:
        self._test_play_path.write_text(json.dumps({"lastProcessedAt": value}), encoding="utf-8")

    # ---- 外部から見える状態 ----
    @property
    def state(self) -> str:
        with self._lock:
            return self._state

    def status_for_heartbeat(self) -> dict[str, Any]:
        """heartbeat.py の `player_status_provider` フックに渡す関数。"""
        with self._lock:
            return {
                "mode": self._mode_for_report,
                "displayHealthy": self._display_healthy,
                "nextVideoAt": self._compute_next_video_at_wall(),
                "lastVideoFinishedAt": (
                    int(self._last_video_finished_wall) if self._last_video_finished_wall is not None else None
                ),
            }

    # ---- ack 受信（server.py の /local/ack から呼ばれる） ----
    def handle_ack(self, transition_id: str | None, phase: str | None) -> None:
        """フェード完了確認 {transitionId, phase} を受け取る。期限を待たず即座に次へ進める。"""
        with self._lock:
            if not transition_id or self._transition_id != transition_id:
                return
            if self._state == FADING_OUT and phase == "fade_out_done":
                self._transition_deadline = self._clock.monotonic()
            elif self._state == FADING_IN and phase == "fade_in_done":
                self._transition_deadline = self._clock.monotonic()

    # ---- メインループ ----
    def tick(self) -> None:
        with self._lock:
            self._tick_locked()

    def _tick_locked(self) -> None:
        config = self._config_provider()
        now_wall = self._clock.wall_time()
        time_synced = bool(self._time_synced_provider())
        schedule = schedule_module.parse_schedule((config or {}).get("schedule"))

        self._reset_excluded_if_new_day(now_wall)

        within_schedule = schedule_module.is_within_display_schedule(schedule, now_wall, time_synced)

        if not within_schedule:
            self._enter_off()
            return

        if self._state == OFF:
            self._leave_off()

        if config is None:
            return  # まだ有効な世代がない

        if self._state == DISPLAY:
            self._tick_display(config)
        elif self._state == FADING_OUT:
            self._tick_fading_out(config)
        elif self._state == PLAYING:
            self._tick_playing()
        elif self._state == FADING_IN:
            self._tick_fading_in()

    # ---- off ----
    def _enter_off(self) -> None:
        if self._state == OFF:
            return
        if self._playback is not None:
            try:
                self._playback.handle.terminate()
            except Exception:
                logger.exception("failed to terminate mpv when entering off")
            self._playback = None
        self._state = OFF
        self._mode_for_report = OFF
        self._display_healthy = True
        self._display_window_started_monotonic = None
        self._transition_id = None
        self._transition_deadline = None
        self._transition_target_item = None
        try:
            self._platform.hdmi_off()
        except Exception:
            logger.exception("hdmi_off failed")
        self._on_log("info", "表示時間外のためHDMI出力を停止し動画を止めました")

    def _leave_off(self) -> None:
        self._state = DISPLAY
        self._mode_for_report = DISPLAY
        self._display_window_started_monotonic = self._clock.monotonic()
        try:
            self._platform.hdmi_on()
        except Exception:
            logger.exception("hdmi_on failed")
        self._on_log("info", "表示時間帯になったためHDMI出力を再開しました")

    # ---- display: 次の動画を出す判断 ----
    def _tick_display(self, config: dict[str, Any]) -> None:
        video = config.get("video") or {}
        enabled = bool(video.get("enabled"))
        playlist = config.get("playlist") or []

        test_play_triggered = self._consume_test_play_if_new(config)

        if not enabled or not playlist:
            return

        if test_play_triggered or self._clock.monotonic() >= self._next_video_at_monotonic(video):
            item = self._select_next_item(playlist, str(video.get("mode", "sequence")))
            if item is None:
                return  # 候補が全滅（本日の失敗除外など）
            self._begin_fading_out(item)

    def _consume_test_play_if_new(self, config: dict[str, Any]) -> bool:
        commands = config.get("commands") or {}
        requested_at = commands.get("testPlayRequestedAt")
        if requested_at is None:
            return False
        requested_at = int(requested_at)
        if self._last_test_play_processed_at is not None and requested_at <= self._last_test_play_processed_at:
            return False
        # 1 回限り: 検出した時点で処理済みとして永続化する（再生の成否に関わらず消費する）。
        self._last_test_play_processed_at = requested_at
        self._save_last_test_play(requested_at)
        return True

    def _next_video_at_monotonic(self, video: dict[str, Any]) -> float:
        """次に動画を始める単調増加時計の時刻 = 起点 + 間隔。

        起点は「前の動画の終了」「起動」「表示時間帯の開始」のうち最も遅いもの
        （lib/display-rules.ts の computeNextVideoAt と同じ規則）。
        """
        interval_seconds = int(video.get("intervalMinutes", 0)) * 60
        anchor = max(
            self._started_monotonic,
            self._last_video_finished_monotonic if self._last_video_finished_monotonic is not None else float("-inf"),
            self._display_window_started_monotonic
            if self._display_window_started_monotonic is not None
            else float("-inf"),
        )
        return anchor + interval_seconds

    def _compute_next_video_at_wall(self) -> int | None:
        config = self._config_provider()
        if not config:
            return None
        video = config.get("video") or {}
        if not video.get("enabled") or not (config.get("playlist") or []):
            return None
        next_m = self._next_video_at_monotonic(video)
        now_m = self._clock.monotonic()
        now_w = self._clock.wall_time()
        return int(now_w + (next_m - now_m))

    # ---- 動画の選択 ----
    def _select_next_item(self, playlist: list[dict[str, Any]], mode: str) -> dict[str, Any] | None:
        candidates = [p for p in playlist if p.get("mediaId") not in self._excluded_today]
        if not candidates:
            return None

        if mode == "random":
            pool = [p for p in candidates if p.get("mediaId") != self._last_played_media_id]
            chosen = random.choice(pool) if pool else random.choice(candidates)
        else:
            chosen = None
            n = len(playlist)
            for offset in range(n):
                idx = (self._sequence_index + offset) % n
                candidate = playlist[idx]
                if candidate.get("mediaId") in self._excluded_today:
                    continue
                self._sequence_index = (idx + 1) % n
                chosen = candidate
                break
            if chosen is None:
                return None

        self._last_played_media_id = chosen.get("mediaId")
        self._save_position()
        return chosen

    def _reset_excluded_if_new_day(self, now_wall: float) -> None:
        date_key = schedule_module.tokyo_date_key(now_wall)
        if self._excluded_date_key != date_key:
            self._excluded_date_key = date_key
            self._excluded_today.clear()

    # ---- フェードアウト ----
    def _begin_fading_out(self, item: dict[str, Any]) -> None:
        self._state = FADING_OUT
        self._mode_for_report = FADING_OUT
        self._transition_id = uuid.uuid4().hex
        self._transition_deadline = self._clock.monotonic() + FADE_ACK_TIMEOUT_SECONDS
        self._transition_target_item = item
        self._notify({"transitionId": self._transition_id, "mode": FADING_OUT})

    def _tick_fading_out(self, config: dict[str, Any]) -> None:
        if self._clock.monotonic() < (self._transition_deadline or 0):
            return
        item = self._transition_target_item
        self._transition_target_item = None
        if item is None:
            self._begin_fading_in()
            return
        self._start_playback(item, config)

    def _start_playback(self, item: dict[str, Any], config: dict[str, Any]) -> None:
        media_path = self._media_path_resolver(str(item.get("sha256", "")))
        volume = int((config.get("device") or {}).get("volume", 0))

        if media_path is None:
            self._on_log("error", f"再生する媒体ファイルが見つかりません media={item.get('mediaId')}")
            self._on_media_failure_for(item, "playback_failed")
            self._finish_playback_slot()
            self._begin_fading_in()
            return

        try:
            handle = self._platform.start_mpv(media_path, volume=volume)
        except platform_module.MpvStartError:
            self._on_log("error", f"mpvの起動に失敗しました media={item.get('mediaId')}")
            self._on_media_failure_for(item, "playback_failed")
            self._finish_playback_slot()
            self._begin_fading_in()
            return

        now_m = self._clock.monotonic()
        self._playback = _PlaybackContext(
            item=item, started_monotonic=now_m, last_progress_monotonic=now_m, last_time_pos=None, handle=handle
        )
        self._state = PLAYING
        self._mode_for_report = PLAYING
        self._notify({"transitionId": self._transition_id, "mode": PLAYING})

    # ---- 再生中の監視 ----
    def _tick_playing(self) -> None:
        pb = self._playback
        if pb is None:
            self._begin_fading_in()
            return

        now_m = self._clock.monotonic()
        exit_code = pb.handle.poll()
        pos = pb.handle.time_pos()

        if pos is not None and (pb.last_time_pos is None or pos > pb.last_time_pos):
            pb.last_progress_monotonic = now_m
        pb.last_time_pos = pos

        if exit_code is not None:
            if exit_code == 0:
                self._on_log("info", f"再生が終了しました media={pb.item.get('mediaId')}")
            else:
                self._on_log(
                    "error", f"再生プロセスが異常終了しました media={pb.item.get('mediaId')} code={exit_code}"
                )
                self._on_media_failure_for(pb.item, "playback_failed")
            self._finish_playback_slot()
            self._begin_fading_in()
            return

        duration = float(pb.item.get("durationSeconds") or 0)
        stalled = (now_m - pb.last_progress_monotonic) >= STALL_TIMEOUT_SECONDS
        overrun = duration > 0 and (now_m - pb.started_monotonic) >= (duration + OVERRUN_SECONDS)
        if stalled or overrun:
            reason = "stalled" if stalled else "overrun"
            self._on_log("error", f"再生を強制終了しました media={pb.item.get('mediaId')} reason={reason}")
            try:
                pb.handle.terminate()
            except Exception:
                logger.exception("failed to terminate stalled/overrun mpv")
            self._on_media_failure_for(pb.item, "playback_failed")
            self._finish_playback_slot()
            self._begin_fading_in()

    def _finish_playback_slot(self) -> None:
        self._playback = None
        now_m = self._clock.monotonic()
        self._last_video_finished_monotonic = now_m
        self._last_video_finished_wall = self._clock.wall_time()

    def _on_media_failure_for(self, item: dict[str, Any], reason: str) -> None:
        media_id = item.get("mediaId")
        if not media_id:
            return
        # 同日内は再生候補から外す（実装計画 8.1 節）。
        self._excluded_today.add(media_id)
        try:
            self._on_media_failure(
                {
                    "mediaId": media_id,
                    "bundleId": None,
                    "reason": reason,
                    "quarantined": False,
                    "occurredAt": int(self._clock.wall_time()),
                }
            )
        except Exception:
            logger.exception("on_media_failure callback failed")

    # ---- フェードイン ----
    def _begin_fading_in(self) -> None:
        self._state = FADING_IN
        self._mode_for_report = FADING_IN
        transition_id = self._transition_id or uuid.uuid4().hex
        self._transition_id = transition_id
        self._transition_deadline = self._clock.monotonic() + FADE_ACK_TIMEOUT_SECONDS
        self._notify({"transitionId": transition_id, "mode": FADING_IN})

    def _tick_fading_in(self) -> None:
        if self._clock.monotonic() < (self._transition_deadline or 0):
            return
        self._state = DISPLAY
        self._mode_for_report = DISPLAY
        self._transition_id = None
        self._transition_deadline = None
        self._notify({"transitionId": None, "mode": DISPLAY})

    # ---- スレッド制御（main.py から呼ぶ） ----
    def start(self, interval_seconds: float = 2.0) -> None:
        if self._thread is not None:
            return
        self._stop_event.clear()

        def loop() -> None:
            while not self._stop_event.is_set():
                try:
                    self.tick()
                except Exception:
                    logger.exception("player tick failed")
                self._stop_event.wait(interval_seconds)

        self._thread = threading.Thread(target=loop, name="player", daemon=True)
        self._thread.start()

    def stop(self, timeout: float | None = 5.0) -> None:
        self._stop_event.set()
        if self._thread is not None:
            self._thread.join(timeout=timeout)
            self._thread = None
