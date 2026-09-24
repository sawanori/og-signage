import json
import threading
import time
import urllib.request
from pathlib import Path

from agent import player as player_mod
from agent import platform as platform_mod
from agent import server as server_mod


def make_config(
    *,
    interval_minutes: int = 5,
    mode: str = "sequence",
    volume: int = 0,
    items: list[dict] | None = None,
    enabled: bool = True,
    test_play_requested_at: int | None = None,
) -> dict:
    if items is None:
        items = [
            {"mediaId": "m1", "sha256": "a" * 64, "size": 100, "durationSeconds": 5},
            {"mediaId": "m2", "sha256": "b" * 64, "size": 100, "durationSeconds": 5},
        ]
    return {
        "schemaVersion": 1,
        "version": "v1",
        "events": [],
        "notices": [],
        "house": {"name": "HOUSE", "rules": []},
        "schedule": [],  # 未設定 = 終日表示
        "weather": None,
        "video": {"enabled": enabled, "intervalMinutes": interval_minutes, "mode": mode},
        "playlist": items,
        "displayBundle": {"id": "bundle1", "sha256": "c" * 64, "size": 1},
        "device": {"orientation": "portrait", "width": 1080, "height": 1920, "volume": volume},
        "commands": {"testPlayRequestedAt": test_play_requested_at},
    }


class PlayerHarness:
    def __init__(self, tmp_path: Path, config: dict, *, time_synced: bool = True):
        self.platform = platform_mod.FakePlatform()
        self.clock = platform_mod.FakeClock()
        self.config = config
        self.time_synced = time_synced
        self.events: list[dict] = []
        self.failures: list[dict] = []
        self.logs: list[tuple[str, str]] = []
        self.player = player_mod.Player(
            self.platform,
            self.clock,
            tmp_path / "state",
            config_provider=lambda: self.config,
            media_path_resolver=lambda sha256: Path(f"/fake/media/{sha256}"),
            time_synced_provider=lambda: self.time_synced,
            notify=self.events.append,
            on_media_failure=self.failures.append,
            on_log=lambda lvl, msg: self.logs.append((lvl, msg)),
        )

    def tick(self) -> None:
        self.player.tick()


def advance_to_fading_out(h: PlayerHarness) -> str:
    """間隔経過まで進めて fading_out に入れ、transitionId を返す。"""
    interval = h.config["video"]["intervalMinutes"] * 60
    h.clock.advance(interval)
    h.tick()
    assert h.player.state == player_mod.FADING_OUT
    return h.events[-1]["transitionId"]


def cross_fade_out_deadline(h: PlayerHarness) -> None:
    h.clock.advance(player_mod.FADE_ACK_TIMEOUT_SECONDS)
    h.tick()


def cross_fade_in_deadline(h: PlayerHarness) -> None:
    h.clock.advance(player_mod.FADE_ACK_TIMEOUT_SECONDS)
    h.tick()


# ---------------------------------------------------------------- 状態遷移と期限切れ


def test_stays_in_display_before_interval_elapses(tmp_path: Path):
    h = PlayerHarness(tmp_path, make_config(interval_minutes=5))
    h.tick()
    assert h.player.state == player_mod.DISPLAY
    assert h.platform.started == []


def test_full_cycle_display_fading_out_playing_fading_in_display_with_ack(tmp_path: Path):
    h = PlayerHarness(tmp_path, make_config(interval_minutes=5))

    transition_id = advance_to_fading_out(h)
    assert h.player.status_for_heartbeat()["mode"] == "fading_out"

    # ack が来る前は期限内なら待つ
    h.clock.advance(1)
    h.tick()
    assert h.player.state == player_mod.FADING_OUT

    h.player.handle_ack(transition_id, "fade_out_done")
    h.tick()
    assert h.player.state == player_mod.PLAYING
    assert len(h.platform.started) == 1
    media_path, volume = h.platform.started[0]
    assert str(media_path) == "/fake/media/" + "a" * 64
    assert volume == 0

    handle = h.platform.started and _last_handle(h)
    handle.finish(0)
    h.tick()
    assert h.player.state == player_mod.FADING_IN

    h.player.handle_ack(transition_id, "fade_in_done")
    h.tick()
    assert h.player.state == player_mod.DISPLAY
    assert h.events[-1] == {"transitionId": None, "mode": "display"}


def _last_handle(h: PlayerHarness) -> platform_mod.FakeMpvHandle:
    # FakePlatform は queue が空なら FakeMpvHandle() を都度生成して返すため、
    # 直近に生成したものを player 内部の再生コンテキストから取得する。
    return h.player._playback.handle  # noqa: SLF001


def test_fading_out_proceeds_after_deadline_without_ack(tmp_path: Path):
    h = PlayerHarness(tmp_path, make_config(interval_minutes=5))
    advance_to_fading_out(h)

    cross_fade_out_deadline(h)
    assert h.player.state == player_mod.PLAYING  # ack が無くても期限切れで進む


def test_fading_in_proceeds_after_deadline_without_ack(tmp_path: Path):
    h = PlayerHarness(tmp_path, make_config(interval_minutes=5))
    advance_to_fading_out(h)
    cross_fade_out_deadline(h)
    assert h.player.state == player_mod.PLAYING

    handle = _last_handle(h)
    handle.finish(0)
    h.tick()
    assert h.player.state == player_mod.FADING_IN

    cross_fade_in_deadline(h)
    assert h.player.state == player_mod.DISPLAY


def test_schedule_off_stops_playback_and_hdmi(tmp_path: Path):
    config = make_config(interval_minutes=5)
    h = PlayerHarness(tmp_path, config)
    advance_to_fading_out(h)
    cross_fade_out_deadline(h)
    assert h.player.state == player_mod.PLAYING

    # 表示時間外に切り替える(未同期のときは消灯しないため time_synced=True にする)
    h.config = dict(config, schedule=[{"weekday": 0, "startTime": "00:00", "endTime": "00:00", "enabled": False}])
    h.time_synced = True
    # weekday=0 が今日と一致するとは限らないため、実際に off になったことは
    # 「時刻未同期なら消灯しない」の対になるテストとして test_schedule.py 側で網羅する。
    # ここでは全曜日を非表示にして必ず off になるようにする。
    h.config["schedule"] = [
        {"weekday": w, "startTime": "00:00", "endTime": "00:00", "enabled": False} for w in range(7)
    ]
    h.tick()
    assert h.player.state == player_mod.OFF
    assert h.platform.hdmi_state == "off"
    handle = h.player._playback  # noqa: SLF001
    assert handle is None


def test_time_unsynced_never_enters_off(tmp_path: Path):
    config = make_config(interval_minutes=5)
    config["schedule"] = [
        {"weekday": w, "startTime": "00:00", "endTime": "00:00", "enabled": False} for w in range(7)
    ]
    h = PlayerHarness(tmp_path, config, time_synced=False)
    h.tick()
    assert h.player.state != player_mod.OFF
    assert h.platform.hdmi_state == "on"


# ---------------------------------------------------------------- mpv 停止検知・尺超過


def test_stalled_playback_is_force_killed_and_reported(tmp_path: Path):
    h = PlayerHarness(tmp_path, make_config(interval_minutes=5))
    handle = platform_mod.FakeMpvHandle()
    h.platform.queue_handle(handle)

    advance_to_fading_out(h)
    cross_fade_out_deadline(h)
    assert h.player.state == player_mod.PLAYING

    handle.set_time_pos(1.0)
    h.tick()  # progress recorded at this monotonic time
    assert h.player.state == player_mod.PLAYING

    h.clock.advance(9.9)
    h.tick()  # まだ 10 秒未満なので続行
    assert h.player.state == player_mod.PLAYING
    assert handle.terminated is False

    h.clock.advance(0.2)  # 合計 10.1 秒進捗なし
    h.tick()
    assert handle.terminated is True
    assert h.player.state == player_mod.FADING_IN
    assert h.failures[-1]["reason"] == "playback_failed"
    assert h.failures[-1]["mediaId"] == "m1"


def test_overrun_beyond_duration_plus_10s_is_force_killed(tmp_path: Path):
    config = make_config(interval_minutes=5, items=[{"mediaId": "m1", "sha256": "a" * 64, "size": 1, "durationSeconds": 5}])
    h = PlayerHarness(tmp_path, config)
    handle = platform_mod.FakeMpvHandle()
    h.platform.queue_handle(handle)

    advance_to_fading_out(h)
    cross_fade_out_deadline(h)
    assert h.player.state == player_mod.PLAYING

    # time-pos は進み続ける（stall ではない）が、尺(5秒)+10秒 の 15 秒を超える
    pos = 0.0
    for _ in range(8):
        pos += 2.0
        handle.set_time_pos(pos)
        h.clock.advance(2.0)
        h.tick()

    assert handle.terminated is True
    assert h.player.state == player_mod.FADING_IN
    assert h.failures[-1]["reason"] == "playback_failed"


def test_mpv_start_failure_reports_failure_and_skips_to_fading_in(tmp_path: Path):
    h = PlayerHarness(tmp_path, make_config(interval_minutes=5))
    h.platform.queue_handle(platform_mod.MpvStartError("boom"))

    advance_to_fading_out(h)
    cross_fade_out_deadline(h)

    assert h.player.state == player_mod.FADING_IN
    assert h.failures[-1]["reason"] == "playback_failed"
    assert h.failures[-1]["mediaId"] == "m1"


# ---------------------------------------------------------------- 失敗媒体の除外


def test_failed_media_excluded_for_rest_of_day_sequence_mode(tmp_path: Path):
    config = make_config(interval_minutes=5, mode="sequence")
    h = PlayerHarness(tmp_path, config)
    h.platform.queue_handle(platform_mod.MpvStartError("boom"))  # m1 が失敗する

    advance_to_fading_out(h)  # m1 を選択
    cross_fade_out_deadline(h)  # 起動失敗 -> fading_in
    cross_fade_in_deadline(h)  # -> display
    assert h.player.state == player_mod.DISPLAY

    # 次の間隔: m1 は本日除外済みなので m2 が選ばれる
    advance_to_fading_out(h)
    cross_fade_out_deadline(h)
    media_path, _ = h.platform.started[-1]
    assert str(media_path) == "/fake/media/" + "b" * 64


def test_excluded_media_is_eligible_again_on_a_new_day(tmp_path: Path):
    config = make_config(interval_minutes=5, mode="sequence")
    h = PlayerHarness(tmp_path, config)
    h.platform.queue_handle(platform_mod.MpvStartError("boom"))

    advance_to_fading_out(h)
    cross_fade_out_deadline(h)
    cross_fade_in_deadline(h)
    assert h.failures[-1]["mediaId"] == "m1"

    # 24 時間以上進めて日付を変える
    h.clock.advance(24 * 60 * 60)
    h.tick()
    # 除外集合がリセットされていることを、内部状態を通じて確認する
    assert "m1" not in h.player._excluded_today  # noqa: SLF001


# ---------------------------------------------------------------- 順番位置の永続化


def test_sequence_position_persists_across_player_restarts(tmp_path: Path):
    config = make_config(interval_minutes=5, mode="sequence")
    h1 = PlayerHarness(tmp_path, config)
    advance_to_fading_out(h1)  # m1 を選択・消費
    cross_fade_out_deadline(h1)
    assert h1.platform.started[-1][0].name == "a" * 64

    # 同じ state ディレクトリで新しい Player を作る（再起動を模す）
    h2 = PlayerHarness(tmp_path, config)
    advance_to_fading_out(h2)
    cross_fade_out_deadline(h2)
    assert h2.platform.started[-1][0].name == "b" * 64  # 続きの m2 から


def test_random_mode_avoids_immediate_repeat_and_persists_last_media(tmp_path: Path):
    items = [{"mediaId": f"m{i}", "sha256": f"{i}" * 64, "size": 1, "durationSeconds": 1} for i in range(2)]
    config = make_config(interval_minutes=5, mode="random", items=items)
    h1 = PlayerHarness(tmp_path, config)
    advance_to_fading_out(h1)
    cross_fade_out_deadline(h1)
    first_media = h1.platform.started[-1][0].name

    h2 = PlayerHarness(tmp_path, config)
    advance_to_fading_out(h2)
    cross_fade_out_deadline(h2)
    second_media = h2.platform.started[-1][0].name

    assert first_media != second_media  # 2件しかないため必ず反対側が選ばれる


# ---------------------------------------------------------------- テスト表示（1 回限り）


def test_test_play_triggers_immediate_playback_once(tmp_path: Path):
    config = make_config(interval_minutes=60, test_play_requested_at=1000)
    h = PlayerHarness(tmp_path, config)

    h.tick()  # 間隔はまだ経過していないが、テスト表示要求がある
    assert h.player.state == player_mod.FADING_OUT

    cross_fade_out_deadline(h)
    handle = _last_handle(h)
    handle.finish(0)
    h.tick()
    cross_fade_in_deadline(h)
    assert h.player.state == player_mod.DISPLAY

    # 同じ requestedAt のままでは再度は発火しない
    h.tick()
    assert h.player.state == player_mod.DISPLAY
    assert len(h.platform.started) == 1


def test_test_play_survives_restart_without_replaying(tmp_path: Path):
    config = make_config(interval_minutes=60, test_play_requested_at=1000)
    h1 = PlayerHarness(tmp_path, config)
    h1.tick()
    assert h1.player.state == player_mod.FADING_OUT  # 1 回目は発火する

    # 同じ state ディレクトリで再起動。testPlayRequestedAt は同じ値のまま。
    h2 = PlayerHarness(tmp_path, config)
    h2.tick()
    assert h2.player.state == player_mod.DISPLAY  # 処理済みなので発火しない
    assert h2.platform.started == []


# ---------------------------------------------------------------- video.enabled / 空プレイリスト


def test_disabled_video_never_plays(tmp_path: Path):
    config = make_config(interval_minutes=1, enabled=False)
    h = PlayerHarness(tmp_path, config)
    h.clock.advance(600)
    h.tick()
    assert h.player.state == player_mod.DISPLAY
    assert h.platform.started == []


def test_empty_playlist_never_plays(tmp_path: Path):
    config = make_config(interval_minutes=1, items=[])
    h = PlayerHarness(tmp_path, config)
    h.clock.advance(600)
    h.tick()
    assert h.player.state == player_mod.DISPLAY
    assert h.platform.started == []


# ---------------------------------------------------------------- 新規 SSE 接続時の初期状態スナップショット


def test_current_state_events_reflects_live_mode_and_transition_id(tmp_path: Path):
    h = PlayerHarness(tmp_path, make_config(interval_minutes=5))
    assert h.player.current_state_events()[0] == {"transitionId": None, "mode": "display"}

    transition_id = advance_to_fading_out(h)
    assert h.player.current_state_events()[0] == {"transitionId": transition_id, "mode": "fading_out"}

    cross_fade_out_deadline(h)
    assert h.player.state == player_mod.PLAYING
    assert h.player.current_state_events()[0] == {"transitionId": transition_id, "mode": "playing"}


def test_current_state_events_includes_time_synced_status(tmp_path: Path):
    h = PlayerHarness(tmp_path, make_config(interval_minutes=5), time_synced=False)
    assert h.player.current_state_events()[1] == {"type": "status", "timeSynced": False}


def test_time_synced_status_event_sent_only_on_change(tmp_path: Path):
    h = PlayerHarness(tmp_path, make_config(interval_minutes=5), time_synced=True)
    h.tick()
    assert h.events == []  # 初期値のままなら通知しない

    h.time_synced = False
    h.tick()
    assert h.events[-1] == {"type": "status", "timeSynced": False}

    h.tick()
    assert h.events[-1] == {"type": "status", "timeSynced": False}  # 変化なしなら再送しない
    assert len([e for e in h.events if e.get("type") == "status"]) == 1

    h.time_synced = True
    h.tick()
    assert h.events[-1] == {"type": "status", "timeSynced": True}


# ---------------------------------------------------------------- SSE と ack の往復（player + server 結合）


def test_transition_round_trip_via_server_sse_and_ack(tmp_path: Path):
    """player の遷移通知が /local/events から届き、表示ページの ack で次の状態へ進むこと。"""

    class DummyGen:
        def current_version(self):
            return None

    clock = platform_mod.FakeClock()
    server = server_mod.LocalServer(DummyGen(), clock, port=0)
    server.start()
    try:
        platform_fake = platform_mod.FakePlatform()
        config = make_config(interval_minutes=5)
        player = player_mod.Player(
            platform_fake,
            clock,
            tmp_path / "state",
            config_provider=lambda: config,
            media_path_resolver=lambda sha256: Path(f"/fake/media/{sha256}"),
            time_synced_provider=lambda: True,
            notify=server.broadcaster.publish,
            on_media_failure=lambda f: None,
        )
        server._on_ack = player.handle_ack  # noqa: SLF001 (main.py 相当の配線をテストで直結する)

        received: list[dict] = []

        def reader():
            req = urllib.request.Request(f"http://127.0.0.1:{server.port}/local/events")
            resp = urllib.request.urlopen(req, timeout=10)
            for raw_line in resp:
                line = raw_line.decode("utf-8").strip()
                if line.startswith("data: "):
                    received.append(json.loads(line[len("data: ") :]))
                    return

        thread = threading.Thread(target=reader, daemon=True)
        thread.start()

        deadline = time.monotonic() + 5
        while server.broadcaster.subscriber_count < 1 and time.monotonic() < deadline:
            time.sleep(0.01)

        clock.advance(5 * 60)
        player.tick()
        assert player.state == player_mod.FADING_OUT

        thread.join(timeout=5)
        assert len(received) == 1
        transition_id = received[0]["transitionId"]
        assert received[0]["mode"] == "fading_out"

        # 表示ページが ack を送る -> player が期限を待たず先へ進む
        req = urllib.request.Request(
            f"http://127.0.0.1:{server.port}/local/ack",
            data=json.dumps({"transitionId": transition_id, "phase": "fade_out_done"}).encode("utf-8"),
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        resp = urllib.request.urlopen(req, timeout=5)
        assert resp.status == 200

        player.tick()
        assert player.state == player_mod.PLAYING
    finally:
        server.stop()


def test_new_sse_connection_receives_current_playing_state_immediately(tmp_path: Path):
    """動画再生中に表示ページが再読み込みされた場合の再現。

    次の遷移を待たずに、新規接続の最初のイベントとして現在の mode ("playing") が届くこと。
    """

    class DummyGen:
        def current_version(self):
            return None

    clock = platform_mod.FakeClock()
    server = server_mod.LocalServer(DummyGen(), clock, port=0)
    server.start()
    try:
        platform_fake = platform_mod.FakePlatform()
        config = make_config(interval_minutes=5)
        player = player_mod.Player(
            platform_fake,
            clock,
            tmp_path / "state",
            config_provider=lambda: config,
            media_path_resolver=lambda sha256: Path(f"/fake/media/{sha256}"),
            time_synced_provider=lambda: True,
            notify=server.broadcaster.publish,
            on_media_failure=lambda f: None,
        )
        server._current_state_provider = player.current_state_events  # noqa: SLF001 (main.py 相当の配線)

        clock.advance(5 * 60)
        player.tick()
        assert player.state == player_mod.FADING_OUT

        clock.advance(player_mod.FADE_ACK_TIMEOUT_SECONDS)
        player.tick()
        assert player.state == player_mod.PLAYING

        # ここで表示ページが再読み込みされ、新規に /local/events へ接続したことを模す
        req = urllib.request.Request(f"http://127.0.0.1:{server.port}/local/events")
        resp = urllib.request.urlopen(req, timeout=10)
        first_event = None
        for raw_line in resp:
            line = raw_line.decode("utf-8").strip()
            if line.startswith("data: "):
                first_event = json.loads(line[len("data: ") :])
                break
        resp.close()

        assert first_event is not None
        assert first_event["mode"] == "playing"
    finally:
        server.stop()


def test_sse_status_event_sent_on_connect_and_on_time_sync_change(tmp_path: Path):
    """/local/events が接続直後と変化時に {type: "status", timeSynced} を送ること。"""

    class DummyGen:
        def current_version(self):
            return None

    clock = platform_mod.FakeClock()
    server = server_mod.LocalServer(DummyGen(), clock, port=0)
    server.start()
    try:
        time_synced_holder = {"value": False}
        platform_fake = platform_mod.FakePlatform()
        config = make_config(interval_minutes=5)
        player = player_mod.Player(
            platform_fake,
            clock,
            tmp_path / "state",
            config_provider=lambda: config,
            media_path_resolver=lambda sha256: Path(f"/fake/media/{sha256}"),
            time_synced_provider=lambda: time_synced_holder["value"],
            notify=server.broadcaster.publish,
            on_media_failure=lambda f: None,
        )
        server._current_state_provider = player.current_state_events  # noqa: SLF001 (main.py 相当の配線)

        received: list[dict] = []

        def reader():
            req = urllib.request.Request(f"http://127.0.0.1:{server.port}/local/events")
            resp = urllib.request.urlopen(req, timeout=10)
            for raw_line in resp:
                line = raw_line.decode("utf-8").strip()
                if line.startswith("data: "):
                    received.append(json.loads(line[len("data: ") :]))
                    if len(received) >= 3:
                        break

        thread = threading.Thread(target=reader, daemon=True)
        thread.start()

        deadline = time.monotonic() + 5
        while server.broadcaster.subscriber_count < 1 and time.monotonic() < deadline:
            time.sleep(0.01)
        assert server.broadcaster.subscriber_count == 1

        time_synced_holder["value"] = True
        player.tick()

        thread.join(timeout=5)

        assert received[0] == {"transitionId": None, "mode": "display"}
        assert received[1] == {"type": "status", "timeSynced": False}
        assert received[2] == {"type": "status", "timeSynced": True}
    finally:
        server.stop()
