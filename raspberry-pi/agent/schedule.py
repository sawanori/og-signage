"""表示スケジュール判定（実装計画 6 節 前提1・8.1 節）。

`lib/display-rules.ts` の `isWithinDisplaySchedule` と同じ結果になるように実装する。
時刻はすべて UNIX 秒で受け渡す。日本時間は UTC+9 固定オフセットで計算し（夏時間なし）、
実行環境の TZ 設定には依存しない（`lib/dates.ts` の tokyoParts と同じ考え方）。

`weekday` は 0=日曜 … 6=土曜（`lib/config-schema.ts` の `weekdaySchema` と同じ並び）。
Python の `datetime.weekday()`（0=月曜 … 6=日曜）とは並びが違うため、
`tokyo_weekday` で変換する。
"""

from __future__ import annotations

import dataclasses
from datetime import datetime, timezone
from typing import Any

TOKYO_OFFSET_SECONDS = 9 * 60 * 60


def _tokyo_datetime(unix_seconds: float) -> datetime:
    return datetime.fromtimestamp(unix_seconds + TOKYO_OFFSET_SECONDS, tz=timezone.utc)


def tokyo_weekday(unix_seconds: float) -> int:
    """0=日曜 … 6=土曜。`lib/dates.ts` の `tokyoWeekday` と同じ。

    Python の `datetime.weekday()` は 0=月曜…6=日曜なので +1 して 7 で割った余りを取る。
    """
    py_weekday = _tokyo_datetime(unix_seconds).weekday()
    return (py_weekday + 1) % 7


def tokyo_minutes_of_day(unix_seconds: float) -> int:
    """日本時間の 0:00 からの経過分（0〜1439）。`lib/dates.ts` の `tokyoMinutesOfDay` と同じ。"""
    d = _tokyo_datetime(unix_seconds)
    return d.hour * 60 + d.minute


def tokyo_date_key(unix_seconds: float) -> str:
    """日本時間での日付キー（YYYY-MM-DD）。`lib/dates.ts` の `tokyoDateKey` と同じ。"""
    d = _tokyo_datetime(unix_seconds)
    return f"{d.year:04d}-{d.month:02d}-{d.day:02d}"


def parse_hhmm(value: str) -> int:
    """"HH:MM" を 0:00 からの分に変換する。`lib/dates.ts` の `parseHHMM` と同じ。"""
    hh, mm = value.split(":")
    return int(hh) * 60 + int(mm)


def is_minute_in_range(minutes: int, start: int, end: int) -> bool:
    """分 `minutes` が [start, end) に入るか。start > end は日をまたぐ時間帯として扱う。
    start === end は終日とみなす。`lib/dates.ts` の `isMinuteInRange` と同じ。
    """
    if start == end:
        return True
    if start < end:
        return start <= minutes < end
    return minutes >= start or minutes < end


@dataclasses.dataclass(frozen=True)
class ScheduleEntry:
    weekday: int  # 0=日曜 … 6=土曜
    start_time: str  # "HH:MM"
    end_time: str  # "HH:MM"
    enabled: bool

    @classmethod
    def from_json(cls, data: dict[str, Any]) -> "ScheduleEntry":
        return cls(
            weekday=int(data["weekday"]),
            start_time=str(data["startTime"]),
            end_time=str(data["endTime"]),
            enabled=bool(data["enabled"]),
        )


def parse_schedule(raw: list[dict[str, Any]] | None) -> list[ScheduleEntry]:
    """config JSON の `schedule` 配列（camelCase）を `ScheduleEntry` の一覧にする。"""
    return [ScheduleEntry.from_json(e) for e in (raw or [])]


def is_within_display_schedule(
    schedule: list[ScheduleEntry],
    now: float,
    time_synced: bool,
) -> bool:
    """表示スケジュール上、今表示してよいか。`lib/display-rules.ts` の
    `isWithinDisplaySchedule` と同じ規則。

    - 未設定の曜日は終日表示。enabled = false の曜日は終日非表示（前日から日をまたいだ分は表示）。
    - 時間帯は [開始, 終了)。開始 > 終了は翌日の終了時刻まで（前日の設定が翌日の早朝を覆う）。
    - 時刻が未同期のときは消灯しない（常に true）。
    """
    if not time_synced:
        return True

    today = tokyo_weekday(now)
    yesterday = (today + 6) % 7
    minutes = tokyo_minutes_of_day(now)

    today_entry = next((e for e in schedule if e.weekday == today), None)
    yesterday_entry = next((e for e in schedule if e.weekday == yesterday), None)

    # 前日の日またぎ分（翌日 0:00〜終了時刻）
    if yesterday_entry is not None and yesterday_entry.enabled:
        y_start = parse_hhmm(yesterday_entry.start_time)
        y_end = parse_hhmm(yesterday_entry.end_time)
        if y_start > y_end and minutes < y_end:
            return True

    if today_entry is None:
        return True
    if not today_entry.enabled:
        return False

    start = parse_hhmm(today_entry.start_time)
    end = parse_hhmm(today_entry.end_time)
    if start == end:
        return True
    if start < end:
        return start <= minutes < end
    # 日またぎ: 当日分は開始〜24:00。0:00〜終了は前日の設定として上で判定済み
    return minutes >= start
