import datetime as dt

from agent import schedule as schedule_mod

JST = dt.timezone(dt.timedelta(hours=9))

# Python の calendar 計算（strftime）を正とした独立の曜日名 -> weekdaySchema 番号の対応表。
# lib/config-schema.ts の weekdaySchema: 0=日曜 … 6=土曜。
_WEEKDAY_NUMBER = {
    "Sunday": 0,
    "Monday": 1,
    "Tuesday": 2,
    "Wednesday": 3,
    "Thursday": 4,
    "Friday": 5,
    "Saturday": 6,
}


def jst_unix(year, month, day, hour=0, minute=0, second=0) -> float:
    return dt.datetime(year, month, day, hour, minute, second, tzinfo=JST).timestamp()


def entry(weekday: int, start: str, end: str, enabled: bool = True) -> schedule_mod.ScheduleEntry:
    return schedule_mod.ScheduleEntry(weekday=weekday, start_time=start, end_time=end, enabled=enabled)


def test_tokyo_weekday_matches_python_calendar_independently():
    """weekdaySchema(0=日曜...6=土曜) と Python の datetime.weekday()(0=月曜...6=日曜) の
    変換が正しいことを、strftime の曜日名（Pythonのカレンダー計算そのもの。tokyo_weekday の
    実装式とは別経路）と突き合わせて確認する。"""
    for year, month, day in [(2026, 9, 20), (2026, 9, 21), (2026, 9, 22), (2026, 9, 23), (2026, 9, 24), (2026, 9, 25), (2026, 9, 26)]:
        d = dt.datetime(year, month, day, 0, 0, 0, tzinfo=JST)
        expected = _WEEKDAY_NUMBER[d.strftime("%A")]
        assert schedule_mod.tokyo_weekday(d.timestamp()) == expected, f"{year}-{month}-{day}"


def test_tokyo_minutes_of_day():
    ts = jst_unix(2026, 1, 10, 13, 45, 30)
    assert schedule_mod.tokyo_minutes_of_day(ts) == 13 * 60 + 45


def test_parse_hhmm_and_is_minute_in_range():
    assert schedule_mod.parse_hhmm("09:30") == 9 * 60 + 30
    assert schedule_mod.is_minute_in_range(10 * 60, 9 * 60, 18 * 60) is True
    assert schedule_mod.is_minute_in_range(20 * 60, 9 * 60, 18 * 60) is False
    # 日またぎ
    assert schedule_mod.is_minute_in_range(23 * 60, 22 * 60, 6 * 60) is True
    assert schedule_mod.is_minute_in_range(3 * 60, 22 * 60, 6 * 60) is True
    assert schedule_mod.is_minute_in_range(12 * 60, 22 * 60, 6 * 60) is False
    # 開始 == 終了 は終日
    assert schedule_mod.is_minute_in_range(0, 8 * 60, 8 * 60) is True


def test_tokyo_date_key_changes_at_midnight_jst():
    before = jst_unix(2026, 9, 22, 23, 59, 59)
    after = jst_unix(2026, 9, 23, 0, 0, 1)
    assert schedule_mod.tokyo_date_key(before) == "2026-09-22"
    assert schedule_mod.tokyo_date_key(after) == "2026-09-23"


def _weekday_of(year: int, month: int, day: int) -> int:
    d = dt.datetime(year, month, day, tzinfo=JST)
    return _WEEKDAY_NUMBER[d.strftime("%A")]


def test_unset_weekday_is_shown_all_day():
    base_year, base_month, base_day = 2026, 9, 21
    configured_weekday = _weekday_of(base_year, base_month, base_day)
    other_weekday = (configured_weekday + 1) % 7  # 未設定の曜日
    schedule = [entry(configured_weekday, "09:00", "18:00")]

    # 未設定の曜日の日を探す
    for offset in range(1, 8):
        year, month, day = base_year, base_month, base_day + offset
        if _weekday_of(year, month, day) == other_weekday:
            ts = jst_unix(year, month, day, 3, 0, 0)  # 早朝でも表示されるはず
            assert schedule_mod.is_within_display_schedule(schedule, ts, True) is True
            return
    raise AssertionError("could not find a date with the target weekday")


def test_disabled_weekday_hides_all_day():
    year, month, day = 2026, 9, 22
    weekday = _weekday_of(year, month, day)
    schedule = [entry(weekday, "00:00", "00:00", enabled=False)]
    ts = jst_unix(year, month, day, 12, 0, 0)
    assert schedule_mod.is_within_display_schedule(schedule, ts, True) is False


def test_normal_time_range_within_and_outside():
    year, month, day = 2026, 9, 22
    weekday = _weekday_of(year, month, day)
    schedule = [entry(weekday, "09:00", "18:00")]
    assert schedule_mod.is_within_display_schedule(schedule, jst_unix(year, month, day, 12, 0), True) is True
    assert schedule_mod.is_within_display_schedule(schedule, jst_unix(year, month, day, 8, 59), True) is False
    assert schedule_mod.is_within_display_schedule(schedule, jst_unix(year, month, day, 18, 0), True) is False


def test_overnight_schedule_crosses_midnight_into_next_day():
    """22:00〜翌6:00 の日またぎ設定。翌日側は「前日の日またぎ分」として表示され、
    翌日自体の設定（非表示）は 6:00 以降にだけ効く。"""
    day1_year, day1_month, day1_day = 2026, 9, 22
    day1_weekday = _weekday_of(day1_year, day1_month, day1_day)
    day2 = dt.datetime(day1_year, day1_month, day1_day, tzinfo=JST) + dt.timedelta(days=1)
    day2_weekday = _weekday_of(day2.year, day2.month, day2.day)

    schedule = [
        entry(day1_weekday, "22:00", "06:00"),
        entry(day2_weekday, "00:00", "00:00", enabled=False),
    ]

    at_23 = jst_unix(day1_year, day1_month, day1_day, 23, 0)
    at_3am_next_day = jst_unix(day2.year, day2.month, day2.day, 3, 0)
    at_7am_next_day = jst_unix(day2.year, day2.month, day2.day, 7, 0)

    assert schedule_mod.is_within_display_schedule(schedule, at_23, True) is True
    assert schedule_mod.is_within_display_schedule(schedule, at_3am_next_day, True) is True
    assert schedule_mod.is_within_display_schedule(schedule, at_7am_next_day, True) is False


def test_time_unsynced_never_hides_display():
    year, month, day = 2026, 9, 22
    weekday = _weekday_of(year, month, day)
    schedule = [entry(weekday, "00:00", "00:00", enabled=False)]  # 本来なら終日非表示のはずの設定
    ts = jst_unix(year, month, day, 12, 0, 0)
    assert schedule_mod.is_within_display_schedule(schedule, ts, False) is True


def test_parse_schedule_from_config_json_shape():
    raw = [
        {"weekday": 1, "startTime": "09:00", "endTime": "18:00", "enabled": True},
        {"weekday": 2, "startTime": "22:00", "endTime": "06:00", "enabled": False},
    ]
    parsed = schedule_mod.parse_schedule(raw)
    assert parsed == [
        schedule_mod.ScheduleEntry(weekday=1, start_time="09:00", end_time="18:00", enabled=True),
        schedule_mod.ScheduleEntry(weekday=2, start_time="22:00", end_time="06:00", enabled=False),
    ]
    assert schedule_mod.parse_schedule(None) == []
