import { describe, expect, it } from "vitest";
import {
  compareHHMM,
  endOfTokyoDay,
  isHHMM,
  isMinuteInRange,
  parseHHMM,
  startOfTokyoDay,
  startOfTokyoWeek,
  tokyoDateKey,
  tokyoDateTime,
  tokyoMinutesOfDay,
  tokyoParts,
  tokyoWeekday,
} from "../../lib/dates";
import { NOW } from "../fixtures/config.fixture";

describe("tokyoDateTime / tokyoParts", () => {
  it("固定日時 2025-09-24 17:42 JST は UTC 08:42 の水曜", () => {
    expect(new Date(NOW * 1000).toISOString()).toBe("2025-09-24T08:42:00.000Z");
    expect(tokyoParts(NOW)).toEqual({
      year: 2025,
      month: 9,
      day: 24,
      hour: 17,
      minute: 42,
      second: 0,
      weekday: 3,
    });
  });
});

describe("日本時間 0:00〜8:59 の日付判定（UTC では前日）", () => {
  it.each([
    [0, 0],
    [0, 1],
    [3, 30],
    [8, 59],
    [9, 0],
  ])("2025-09-25 %i:%i JST は 9/25(木)", (hour, minute) => {
    const t = tokyoDateTime(2025, 9, 25, hour, minute);
    expect(tokyoDateKey(t)).toBe("2025-09-25");
    expect(tokyoWeekday(t)).toBe(4);
    expect(startOfTokyoDay(t)).toBe(tokyoDateTime(2025, 9, 25, 0, 0));
  });

  it("0:00 JST は UTC では前日 15:00", () => {
    const t = tokyoDateTime(2025, 9, 25, 0, 0);
    expect(new Date(t * 1000).toISOString()).toBe("2025-09-24T15:00:00.000Z");
  });

  it("23:59:59 JST はまだ当日", () => {
    const t = tokyoDateTime(2025, 9, 24, 23, 59, 59);
    expect(tokyoDateKey(t)).toBe("2025-09-24");
    expect(endOfTokyoDay(NOW)).toBe(t);
  });

  it("月末・年末もまたげる", () => {
    expect(tokyoDateKey(tokyoDateTime(2025, 12, 31, 23, 0) + 3600)).toBe("2026-01-01");
    expect(tokyoDateKey(tokyoDateTime(2025, 10, 1, 0, 30))).toBe("2025-10-01");
  });
});

describe("startOfTokyoWeek（月曜始まり）", () => {
  const monday = tokyoDateTime(2025, 9, 22, 0, 0);

  it.each([
    ["月曜 0:00", tokyoDateTime(2025, 9, 22, 0, 0)],
    ["水曜 17:42", NOW],
    ["日曜 0:30（UTC では土曜）", tokyoDateTime(2025, 9, 28, 0, 30)],
    ["日曜 23:59:59", tokyoDateTime(2025, 9, 28, 23, 59, 59)],
  ])("%s の週は 9/22(月) から", (_, t) => {
    expect(startOfTokyoWeek(t)).toBe(monday);
  });

  it("翌月曜 0:00 は次の週", () => {
    const next = tokyoDateTime(2025, 9, 29, 0, 0);
    expect(startOfTokyoWeek(next)).toBe(next);
  });
});

describe("HH:MM", () => {
  it("形式を判定する", () => {
    expect(isHHMM("00:00")).toBe(true);
    expect(isHHMM("23:59")).toBe(true);
    expect(isHHMM("24:00")).toBe(false);
    expect(isHHMM("9:00")).toBe(false);
    expect(isHHMM("12:60")).toBe(false);
  });

  it("分に変換して比較する", () => {
    expect(parseHHMM("19:30")).toBe(1170);
    expect(compareHHMM("09:00", "18:00")).toBeLessThan(0);
    expect(compareHHMM("18:00", "18:00")).toBe(0);
    expect(compareHHMM("23:00", "01:00")).toBeGreaterThan(0);
    expect(() => parseHHMM("7:00")).toThrow();
  });

  it("日本時間の経過分", () => {
    expect(tokyoMinutesOfDay(NOW)).toBe(17 * 60 + 42);
    expect(tokyoMinutesOfDay(tokyoDateTime(2025, 9, 25, 0, 5))).toBe(5);
  });

  it("時間帯 [開始, 終了) の判定（日またぎ含む）", () => {
    expect(isMinuteInRange(parseHHMM("09:00"), parseHHMM("09:00"), parseHHMM("18:00"))).toBe(true);
    expect(isMinuteInRange(parseHHMM("18:00"), parseHHMM("09:00"), parseHHMM("18:00"))).toBe(false);
    expect(isMinuteInRange(parseHHMM("23:30"), parseHHMM("22:00"), parseHHMM("06:00"))).toBe(true);
    expect(isMinuteInRange(parseHHMM("05:59"), parseHHMM("22:00"), parseHHMM("06:00"))).toBe(true);
    expect(isMinuteInRange(parseHHMM("06:00"), parseHHMM("22:00"), parseHHMM("06:00"))).toBe(false);
  });
});
