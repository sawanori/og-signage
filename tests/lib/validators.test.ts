import { describe, expect, it } from "vitest";
import { tokyoDateTime } from "../../lib/dates";
import {
  designSettingsSchema,
  deviceLogsSchema,
  displayScheduleSchema,
  eventInputSchema,
  eventUpdateSchema,
  heartbeatSchema,
  houseRulesSchema,
  mediaFailuresSchema,
  noticeInputSchema,
  videoSettingsInputSchema,
} from "../../lib/validators";
import { NOW, fakeSha256 } from "../fixtures/config.fixture";

function messages(result: { success: boolean; error?: { issues: { message: string }[] } }): string[] {
  return result.error?.issues.map((i) => i.message) ?? [];
}

const validEvent = {
  title: "Pizza Night",
  startAt: tokyoDateTime(2025, 9, 24, 19, 30),
  endAt: tokyoDateTime(2025, 9, 24, 21, 30),
  location: "2F ラウンジ",
  participation: "free",
  qrUrl: "https://example.com/pizza",
  status: "published",
};

describe("イベント入力", () => {
  it("正しい入力を通し、空欄の任意項目は null にする", () => {
    const parsed = eventInputSchema.parse({ ...validEvent, description: "", imageMediaId: "", qrUrl: "" });
    expect(parsed.description).toBeNull();
    expect(parsed.imageMediaId).toBeNull();
    expect(parsed.qrUrl).toBeNull();
    expect(parsed.hostName).toBeNull();
  });

  it("終了なしを許す", () => {
    expect(eventInputSchema.safeParse({ ...validEvent, endAt: null }).success).toBe(true);
  });

  it("終了は開始より後（同時刻も不可）", () => {
    const same = eventInputSchema.safeParse({ ...validEvent, endAt: validEvent.startAt });
    expect(same.success).toBe(false);
    expect(messages(same)).toContain("終了は開始より後にしてください");
    expect(eventInputSchema.safeParse({ ...validEvent, endAt: validEvent.startAt - 60 }).success).toBe(false);
  });

  it("イベント名は必須", () => {
    expect(eventInputSchema.safeParse({ ...validEvent, title: "  " }).success).toBe(false);
  });

  it.each(["javascript:alert(1)", "ftp://example.com/a", "data:text/html,x", "example.com"])(
    "QR の URL は http/https のみ（%s は不可）",
    (qrUrl) => {
      expect(eventInputSchema.safeParse({ ...validEvent, qrUrl }).success).toBe(false);
    },
  );

  it("http の URL は通す", () => {
    expect(eventInputSchema.safeParse({ ...validEvent, qrUrl: "http://example.com/a" }).success).toBe(true);
  });

  it("定員ありは定員が必須", () => {
    expect(eventInputSchema.safeParse({ ...validEvent, participation: "limited" }).success).toBe(false);
    expect(
      eventInputSchema.safeParse({ ...validEvent, participation: "limited", capacity: 20, participantCount: 12 })
        .success,
    ).toBe(true);
  });

  it("更新は revision が必須", () => {
    expect(eventUpdateSchema.safeParse(validEvent).success).toBe(false);
    expect(eventUpdateSchema.safeParse({ ...validEvent, revision: 3 }).success).toBe(true);
    expect(eventUpdateSchema.safeParse({ ...validEvent, revision: 3, endAt: validEvent.startAt }).success).toBe(false);
  });
});

describe("お知らせ入力", () => {
  const valid = { title: "共用部の清掃にご協力ください", body: "よろしくお願いします。", enabled: true, displayMode: "always" };

  it("本文は 100 文字まで", () => {
    expect(noticeInputSchema.safeParse({ ...valid, body: "あ".repeat(100) }).success).toBe(true);
    const over = noticeInputSchema.safeParse({ ...valid, body: "あ".repeat(101) });
    expect(over.success).toBe(false);
    expect(messages(over)).toContain("本文は100文字以内で入力してください");
  });

  it("絵文字は 1 文字と数える", () => {
    expect(noticeInputSchema.safeParse({ ...valid, body: "🍕".repeat(100) }).success).toBe(true);
  });

  it("時間帯指定は開始・終了が必須で、日またぎを許す", () => {
    expect(noticeInputSchema.safeParse({ ...valid, displayMode: "timeRange" }).success).toBe(false);
    expect(
      noticeInputSchema.safeParse({ ...valid, displayMode: "timeRange", displayStartTime: "22:00", displayEndTime: "06:00" })
        .success,
    ).toBe(true);
    expect(
      noticeInputSchema.safeParse({ ...valid, displayMode: "timeRange", displayStartTime: "08:00", displayEndTime: "08:00" })
        .success,
    ).toBe(false);
    expect(
      noticeInputSchema.safeParse({ ...valid, displayMode: "timeRange", displayStartTime: "8:00", displayEndTime: "10:00" })
        .success,
    ).toBe(false);
  });
});

describe("デザイン設定・ハウスルール", () => {
  it("デザイン設定を検証する", () => {
    const valid = {
      houseName: "HARMONY HOUSE",
      headerCopy: "Welcome Home!",
      footerCopy: "Same House, Different Stories.",
      categories: [{ id: "cat_social", color: "#F97316" }],
      revision: 0,
    };
    expect(designSettingsSchema.safeParse(valid).success).toBe(true);
    expect(designSettingsSchema.safeParse({ ...valid, houseName: "" }).success).toBe(false);
    expect(designSettingsSchema.safeParse({ ...valid, categories: [{ id: "c", color: "orange" }] }).success).toBe(false);
  });

  it("ハウスルールは 3 件まで", () => {
    const rule = { icon: "volume-x", text: "22時以降はお静かに" };
    expect(houseRulesSchema.safeParse({ rules: [rule, rule, rule] }).success).toBe(true);
    expect(houseRulesSchema.safeParse({ rules: [rule, rule, rule, rule] }).success).toBe(false);
    expect(houseRulesSchema.safeParse({ rules: [{ icon: "x", text: "" }] }).success).toBe(false);
  });
});

describe("表示スケジュール入力", () => {
  it("日またぎを許し、曜日の重複と開始 = 終了を拒否する", () => {
    expect(
      displayScheduleSchema.safeParse({ entries: [{ weekday: 3, startTime: "22:00", endTime: "06:00", enabled: true }] })
        .success,
    ).toBe(true);
    expect(
      displayScheduleSchema.safeParse({
        entries: [
          { weekday: 3, startTime: "09:00", endTime: "18:00", enabled: true },
          { weekday: 3, startTime: "19:00", endTime: "20:00", enabled: true },
        ],
      }).success,
    ).toBe(false);
    expect(
      displayScheduleSchema.safeParse({ entries: [{ weekday: 1, startTime: "09:00", endTime: "09:00", enabled: true }] })
        .success,
    ).toBe(false);
    expect(
      displayScheduleSchema.safeParse({ entries: [{ weekday: 7, startTime: "09:00", endTime: "10:00", enabled: true }] })
        .success,
    ).toBe(false);
  });
});

describe("動画設定入力", () => {
  const valid = { enabled: true, intervalMinutes: 10, mode: "sequence", mediaIds: ["med_welcome"], revision: 1 };

  it.each([5, 10, 15, 20, 30, 60])("間隔 %i 分は通す", (intervalMinutes) => {
    expect(videoSettingsInputSchema.safeParse({ ...valid, intervalMinutes }).success).toBe(true);
  });

  it.each([0, 1, 7, 45, 90, "10"])("間隔 %s は拒否する", (intervalMinutes) => {
    expect(videoSettingsInputSchema.safeParse({ ...valid, intervalMinutes }).success).toBe(false);
  });
});

describe("端末 API", () => {
  const heartbeat = {
    agentVersion: "0.1.0",
    bundleId: "bundle_2025_09_24_1",
    appliedVersion: fakeSha256(1),
    pendingVersion: null,
    mode: "display",
    displayHealthy: true,
    nextVideoAt: NOW + 600,
    lastVideoFinishedAt: NOW,
    timeSynced: true,
    diskFreeBytes: 10_000_000_000,
    cpuTempC: 52.5,
    memAvailableBytes: 1_500_000_000,
  };

  it("heartbeat を検証する", () => {
    expect(heartbeatSchema.safeParse(heartbeat).success).toBe(true);
    expect(heartbeatSchema.safeParse({ ...heartbeat, mode: "sleeping" }).success).toBe(false);
    expect(heartbeatSchema.safeParse({ ...heartbeat, diskFreeBytes: -1 }).success).toBe(false);
    const { timeSynced: _omit, ...missing } = heartbeat;
    void _omit;
    expect(heartbeatSchema.safeParse(missing).success).toBe(false);
  });

  it("logs は 1〜50 件", () => {
    const log = { type: "sync", message: "config applied", createdAt: NOW };
    expect(deviceLogsSchema.safeParse({ logs: Array(50).fill(log) }).success).toBe(true);
    expect(deviceLogsSchema.safeParse({ logs: Array(51).fill(log) }).success).toBe(false);
    expect(deviceLogsSchema.safeParse({ logs: [] }).success).toBe(false);
  });

  it("media-failures を検証する", () => {
    const failure = { mediaId: "med_welcome", reason: "hash_mismatch", quarantined: true, occurredAt: NOW };
    expect(mediaFailuresSchema.safeParse({ failures: [failure] }).success).toBe(true);
    expect(mediaFailuresSchema.safeParse({ failures: [{ ...failure, reason: "unknown" }] }).success).toBe(false);
  });
});
