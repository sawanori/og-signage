import hashlib
from pathlib import Path

from agent import generations as gen_mod
from agent import platform as platform_mod
from agent import schedule as schedule_mod
from agent import watchdog as watchdog_mod


def make_generation(gm: gen_mod.GenerationManager, version: str, bundle_id: str) -> None:
    content = b"video"
    sha = hashlib.sha256(content).hexdigest()
    gm.media_path(sha).write_bytes(content)
    entry = gen_mod.ManifestEntry(kind="media", key=sha, sha256=sha, size=len(content))
    gm.write_generation(
        version, {"version": version, "displayBundle": {"id": bundle_id}}, gen_mod.Manifest(version, (entry,))
    )
    gm.activate(version)


def build_watchdog(gm, platform, clock, ack_provider, **kwargs):
    logs: list[tuple[str, str]] = []
    wd = watchdog_mod.Watchdog(
        platform,
        clock,
        gm,
        ack_monotonic_provider=ack_provider,
        on_log=lambda lvl, msg: logs.append((lvl, msg)),
        **kwargs,
    )
    return wd, logs


def test_no_restart_while_ack_is_recent(data_dir: Path):
    gm = gen_mod.GenerationManager(data_dir)
    plat = platform_mod.FakePlatform()
    clock = platform_mod.FakeClock()
    wd, logs = build_watchdog(gm, plat, clock, lambda: clock.monotonic())

    clock.advance(30)
    wd.tick(schedule=[], time_synced=False)

    assert plat.chromium_restart_count == 0
    assert plat.exit_calls == []


def test_ack_silence_60s_restarts_chromium(data_dir: Path):
    gm = gen_mod.GenerationManager(data_dir)
    plat = platform_mod.FakePlatform()
    clock = platform_mod.FakeClock()
    last_ack = {"at": 0.0}
    wd, logs = build_watchdog(gm, plat, clock, lambda: last_ack["at"])

    clock.advance(59)
    wd.tick(schedule=[], time_synced=False)
    assert plat.chromium_restart_count == 0

    clock.advance(2)  # 合計 61 秒: 60 秒しきい値を超える
    wd.tick(schedule=[], time_synced=False)
    assert plat.chromium_restart_count == 1
    assert any("Chromium" in msg for _, msg in logs)


def test_ack_silence_continues_120s_after_restart_exits_agent(data_dir: Path):
    gm = gen_mod.GenerationManager(data_dir)
    plat = platform_mod.FakePlatform()
    clock = platform_mod.FakeClock()
    last_ack = {"at": 0.0}
    wd, logs = build_watchdog(gm, plat, clock, lambda: last_ack["at"])

    clock.advance(61)
    wd.tick(schedule=[], time_synced=False)  # Chromium 再起動 (t=61)
    assert plat.chromium_restart_count == 1
    assert plat.exit_calls == []

    clock.advance(119)  # 再起動から 119 秒経過（まだ 120 未満）
    wd.tick(schedule=[], time_synced=False)
    assert plat.exit_calls == []

    clock.advance(2)  # 再起動から 121 秒経過
    wd.tick(schedule=[], time_synced=False)
    assert plat.exit_calls == [1]


def test_ack_after_chromium_restart_cancels_agent_exit(data_dir: Path):
    gm = gen_mod.GenerationManager(data_dir)
    plat = platform_mod.FakePlatform()
    clock = platform_mod.FakeClock()
    last_ack = {"at": 0.0}
    wd, logs = build_watchdog(gm, plat, clock, lambda: last_ack["at"])

    clock.advance(61)
    wd.tick(schedule=[], time_synced=False)
    assert plat.chromium_restart_count == 1

    # 再起動後に新しい ack が届いた（Chromium が復帰した）
    clock.advance(5)
    last_ack["at"] = clock.monotonic()

    clock.advance(50)  # 復帰後 50 秒（60 秒未満の静穏さで再起動しきい値に達しない）
    wd.tick(schedule=[], time_synced=False)
    assert plat.exit_calls == []
    assert plat.chromium_restart_count == 1  # 再度の再起動は起きない


def test_daily_restart_at_4am_when_schedule_is_24h(data_dir: Path):
    gm = gen_mod.GenerationManager(data_dir)
    plat = platform_mod.FakePlatform()
    clock = platform_mod.FakeClock(wall_start=0.0)
    wd, logs = build_watchdog(gm, plat, clock, lambda: clock.monotonic())

    import datetime as dt

    jst = dt.timezone(dt.timedelta(hours=9))
    at_3_59 = dt.datetime(2026, 9, 22, 3, 59, 0, tzinfo=jst).timestamp()
    at_4_00 = dt.datetime(2026, 9, 22, 4, 0, 0, tzinfo=jst).timestamp()

    clock.set_wall(at_3_59)
    wd.tick(schedule=[], time_synced=True)
    assert plat.chromium_restart_count == 0

    clock.set_wall(at_4_00)
    wd.tick(schedule=[], time_synced=True)
    assert plat.chromium_restart_count == 1

    # 同じ日にもう一度 4:00 台に呼ばれても再起動は1回だけ
    wd.tick(schedule=[], time_synced=True)
    assert plat.chromium_restart_count == 1


def test_daily_restart_skipped_when_time_not_synced(data_dir: Path):
    gm = gen_mod.GenerationManager(data_dir)
    plat = platform_mod.FakePlatform()
    clock = platform_mod.FakeClock(wall_start=0.0)
    wd, logs = build_watchdog(gm, plat, clock, lambda: clock.monotonic())

    import datetime as dt

    jst = dt.timezone(dt.timedelta(hours=9))
    at_4_00 = dt.datetime(2026, 9, 22, 4, 0, 0, tzinfo=jst).timestamp()
    clock.set_wall(at_4_00)
    wd.tick(schedule=[], time_synced=False)
    assert plat.chromium_restart_count == 0


def test_daily_restart_happens_during_off_window_before_4am(data_dir: Path):
    gm = gen_mod.GenerationManager(data_dir)
    plat = platform_mod.FakePlatform()
    clock = platform_mod.FakeClock(wall_start=0.0)
    wd, logs = build_watchdog(gm, plat, clock, lambda: clock.monotonic())

    import datetime as dt

    jst = dt.timezone(dt.timedelta(hours=9))
    at_1am = dt.datetime(2026, 9, 22, 1, 0, 0, tzinfo=jst).timestamp()
    weekday = schedule_mod.tokyo_weekday(at_1am)
    schedule = [schedule_mod.ScheduleEntry(weekday=weekday, start_time="00:00", end_time="00:00", enabled=False)]

    clock.set_wall(at_1am)
    wd.tick(schedule=schedule, time_synced=True)
    assert plat.chromium_restart_count == 1  # 表示時間外なので 4:00 を待たず再起動する

    at_4am = dt.datetime(2026, 9, 22, 4, 0, 0, tzinfo=jst).timestamp()
    clock.set_wall(at_4am)
    wd.tick(schedule=schedule, time_synced=True)
    assert plat.chromium_restart_count == 1  # 同日はもう再起動しない


def test_bundle_change_without_ack_within_60s_rolls_back(data_dir: Path):
    gm = gen_mod.GenerationManager(data_dir)
    plat = platform_mod.FakePlatform()
    clock = platform_mod.FakeClock()
    last_ack = {"at": 0.0}
    wd, logs = build_watchdog(gm, plat, clock, lambda: last_ack["at"])

    make_generation(gm, "v1", "bundleA")
    wd.tick(schedule=[], time_synced=False)  # 初回観測。まだ previous が無いので何も武装しない
    assert gm.current_version() == "v1"

    make_generation(gm, "v2", "bundleB")
    assert gm.previous_version() == "v1"

    clock.advance(1)
    wd.tick(schedule=[], time_synced=False)  # バンドル変更を検知して 60 秒の生存確認を開始

    clock.advance(59)
    wd.tick(schedule=[], time_synced=False)
    assert gm.current_version() == "v2"  # まだ戻さない

    clock.advance(2)  # 合計 61 秒、ack が一度も来ていない
    wd.tick(schedule=[], time_synced=False)
    assert gm.current_version() == "v1"  # previous へ戻った
    assert any("戻しました" in msg for _, msg in logs)


def test_bundle_change_with_ack_within_60s_keeps_new_version(data_dir: Path):
    gm = gen_mod.GenerationManager(data_dir)
    plat = platform_mod.FakePlatform()
    clock = platform_mod.FakeClock()
    last_ack = {"at": 0.0}
    wd, logs = build_watchdog(gm, plat, clock, lambda: last_ack["at"])

    make_generation(gm, "v1", "bundleA")
    wd.tick(schedule=[], time_synced=False)

    make_generation(gm, "v2", "bundleB")
    clock.advance(1)
    wd.tick(schedule=[], time_synced=False)  # 生存確認を開始（armed_at = 1）

    clock.advance(10)
    last_ack["at"] = clock.monotonic()  # 新バンドル配信後に ack が届いた
    wd.tick(schedule=[], time_synced=False)

    clock.advance(100)
    wd.tick(schedule=[], time_synced=False)
    assert gm.current_version() == "v2"  # 戻らない


def test_bundle_check_not_armed_when_no_previous_generation(data_dir: Path):
    gm = gen_mod.GenerationManager(data_dir)
    plat = platform_mod.FakePlatform()
    clock = platform_mod.FakeClock()
    last_ack = {"at": 0.0}
    wd, logs = build_watchdog(gm, plat, clock, lambda: last_ack["at"])

    make_generation(gm, "v1", "bundleA")
    wd.tick(schedule=[], time_synced=False)  # 初回観測（previous 無し）

    clock.advance(1000)
    wd.tick(schedule=[], time_synced=False)
    assert gm.current_version() == "v1"  # ロールバック対象が無いので何も起きない
