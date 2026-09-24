/**
 * Asia/Tokyo 基準の日時ユーティリティ。
 *
 * 時刻はすべて UNIX 秒で受け渡す。日本は夏時間がないため UTC+9 の固定オフセットで計算し、
 * 実行環境の TZ（Date#getHours など）には一切依存しない。
 */

export const TOKYO_OFFSET_SECONDS = 9 * 60 * 60;
export const SECONDS_PER_DAY = 24 * 60 * 60;

/** 0 = 日曜 … 6 = 土曜（Date#getDay と同じ並び） */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export type TokyoParts = {
  year: number;
  /** 1〜12 */
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: Weekday;
};

/** 日本時間での年月日・時分秒・曜日 */
export function tokyoParts(unixSeconds: number): TokyoParts {
  const shifted = new Date((unixSeconds + TOKYO_OFFSET_SECONDS) * 1000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    weekday: shifted.getUTCDay() as Weekday,
  };
}

/** 日本時間の年月日時分から UNIX 秒を作る（month は 1〜12） */
export function tokyoDateTime(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): number {
  return Date.UTC(year, month - 1, day, hour, minute, second) / 1000 - TOKYO_OFFSET_SECONDS;
}

/** 日本時間のその日の 0:00:00 */
export function startOfTokyoDay(unixSeconds: number): number {
  const local = unixSeconds + TOKYO_OFFSET_SECONDS;
  return local - mod(local, SECONDS_PER_DAY) - TOKYO_OFFSET_SECONDS;
}

/** 日本時間のその日の 23:59:59 */
export function endOfTokyoDay(unixSeconds: number): number {
  return startOfTokyoDay(unixSeconds) + SECONDS_PER_DAY - 1;
}

/** 日本時間での日付キー（YYYY-MM-DD） */
export function tokyoDateKey(unixSeconds: number): string {
  const p = tokyoParts(unixSeconds);
  return `${p.year}-${pad2(p.month)}-${pad2(p.day)}`;
}

export function isSameTokyoDay(a: number, b: number): boolean {
  return startOfTokyoDay(a) === startOfTokyoDay(b);
}

export function tokyoWeekday(unixSeconds: number): Weekday {
  return tokyoParts(unixSeconds).weekday;
}

/** 日本時間の週の始まり（月曜 0:00:00） */
export function startOfTokyoWeek(unixSeconds: number): number {
  const dayStart = startOfTokyoDay(unixSeconds);
  const daysSinceMonday = (tokyoWeekday(unixSeconds) + 6) % 7;
  return dayStart - daysSinceMonday * SECONDS_PER_DAY;
}

/** 日本時間の 0:00 からの経過分（0〜1439） */
export function tokyoMinutesOfDay(unixSeconds: number): number {
  const p = tokyoParts(unixSeconds);
  return p.hour * 60 + p.minute;
}

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isHHMM(value: string): boolean {
  return HHMM.test(value);
}

/** "HH:MM" を 0:00 からの分に変換する。形式が違えば例外 */
export function parseHHMM(value: string): number {
  const m = HHMM.exec(value);
  if (!m) throw new Error(`HH:MM 形式ではありません: ${value}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** HH:MM 同士の比較（a < b で負、等しければ 0、a > b で正） */
export function compareHHMM(a: string, b: string): number {
  return parseHHMM(a) - parseHHMM(b);
}

/**
 * 分 `minutes` が [start, end) に入るか。start > end は日をまたぐ時間帯として扱う。
 * start === end は終日とみなす。
 */
export function isMinuteInRange(minutes: number, start: number, end: number): boolean {
  if (start === end) return true;
  if (start < end) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
