/**
 * 入力の検証（管理画面の入力と端末 API）。エラーメッセージは利用者向けの日本語。
 * 時刻は UNIX 秒、時間帯は日本時間の HH:MM。
 */
import { z } from "zod";
import { VIDEO_INTERVAL_MINUTES, weekdaySchema } from "./config-schema";
import { isHHMM } from "./dates";

export const NOTICE_BODY_MAX = 100;
export const DEVICE_LOGS_MAX = 50;
export const MEDIA_FAILURES_MAX = 50;

/** 文字数（サロゲートペアや絵文字を 1 文字と数える） */
export function countChars(value: string): number {
  return [...value].length;
}

/** 必須の文字列。前後の空白を除いて 1〜max 文字 */
function requiredText(label: string, max: number) {
  return z
    .string()
    .trim()
    .min(1, `${label}を入力してください`)
    .refine((v) => countChars(v) <= max, `${label}は${max}文字以内で入力してください`);
}

/** 任意の文字列。空欄は null にする */
function optionalText(label: string, max: number) {
  return z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? null : v),
    z
      .string()
      .trim()
      .refine((v) => countChars(v) <= max, `${label}は${max}文字以内で入力してください`)
      .nullable()
      .default(null),
  );
}

const optionalId = z.preprocess((v) => (v === "" ? null : v), z.string().min(1).nullable().default(null));

const unixSeconds = z.int("日時が正しくありません").nonnegative("日時が正しくありません");
const revision = z.int().nonnegative();
const hhmm = z.string().refine(isHHMM, "時刻は HH:MM の形式で入力してください");

/** http / https の URL のみ */
export const httpUrlSchema = z.url({
  protocol: /^https?$/,
  error: "URL は http:// か https:// で始まるものを入力してください",
});

const optionalHttpUrl = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? null : typeof v === "string" ? v.trim() : v),
  httpUrlSchema.nullable().default(null),
);

// ---------------------------------------------------------------- イベント

const eventFields = z.object({
  title: requiredText("イベント名", 100),
  description: optionalText("説明", 1000),
  location: optionalText("場所", 100),
  startAt: unixSeconds,
  endAt: unixSeconds.nullable().default(null),
  categoryId: optionalId,
  emoji: optionalText("絵文字", 8),
  hostName: optionalText("主催者名", 100),
  catchCopy: optionalText("キャッチコピー", 60),
  participation: z.enum(["free", "limited"]),
  capacity: z.int().positive("定員は1以上で入力してください").nullable().default(null),
  participantCount: z.int().nonnegative("参加人数は0以上で入力してください").nullable().default(null),
  qrUrl: optionalHttpUrl,
  imageMediaId: optionalId,
  status: z.enum(["published", "draft"]),
});

type EventFields = z.infer<typeof eventFields>;

function checkEvent(value: EventFields, ctx: z.RefinementCtx) {
  if (value.endAt !== null && value.endAt <= value.startAt) {
    ctx.addIssue({ code: "custom", path: ["endAt"], message: "終了は開始より後にしてください" });
  }
  if (value.participation === "limited" && value.capacity === null) {
    ctx.addIssue({ code: "custom", path: ["capacity"], message: "定員を入力してください" });
  }
}

export const eventInputSchema = eventFields.superRefine(checkEvent);
export const eventUpdateSchema = eventFields.extend({ revision }).superRefine(checkEvent);

// ---------------------------------------------------------------- お知らせ

const noticeFields = z.object({
  title: requiredText("見出し", 50),
  body: optionalText("本文", NOTICE_BODY_MAX),
  imageMediaId: optionalId,
  enabled: z.boolean(),
  displayMode: z.enum(["always", "timeRange"]),
  displayStartTime: hhmm.nullable().default(null),
  displayEndTime: hhmm.nullable().default(null),
});

type NoticeFields = z.infer<typeof noticeFields>;

function checkNotice(value: NoticeFields, ctx: z.RefinementCtx) {
  if (value.displayMode !== "timeRange") return;
  if (value.displayStartTime === null) {
    ctx.addIssue({ code: "custom", path: ["displayStartTime"], message: "表示の開始時刻を入力してください" });
  }
  if (value.displayEndTime === null) {
    ctx.addIssue({ code: "custom", path: ["displayEndTime"], message: "表示の終了時刻を入力してください" });
  }
  if (value.displayStartTime !== null && value.displayStartTime === value.displayEndTime) {
    ctx.addIssue({ code: "custom", path: ["displayEndTime"], message: "開始と終了に同じ時刻は指定できません" });
  }
}

export const noticeInputSchema = noticeFields.superRefine(checkNotice);
export const noticeUpdateSchema = noticeFields.extend({ revision }).superRefine(checkNotice);

// ---------------------------------------------------------------- デザイン設定

export const designSettingsSchema = z.object({
  houseName: requiredText("ハウス名", 50),
  headerCopy: optionalText("ヘッダーのキャッチコピー", 60),
  footerCopy: optionalText("フッターのキャッチコピー", 60),
  /** フッターの QR コードの飛び先（例: 会議室予約のページ）。空欄なら QR の場所だけ空けておく */
  footerQrUrl: optionalHttpUrl,
  logoMediaId: optionalId,
  footerImageMediaId: optionalId,
  weatherLocationName: optionalText("天気の地域名", 50),
  weatherLatitude: z.number().min(-90).max(90).nullable().default(null),
  weatherLongitude: z.number().min(-180).max(180).nullable().default(null),
  categories: z.array(
    z.object({
      id: z.string().min(1),
      color: z.string().regex(/^#[0-9a-fA-F]{6}$/, "色は #RRGGBB の形式で入力してください"),
    }),
  ),
  revision,
});

// ---------------------------------------------------------------- ハウスルール

export const HOUSE_RULES_MAX = 3;
/** メンバー情報の見出し（アイコンの代わりに出す 1 行）の文字数 */
export const HOUSE_RULE_TITLE_MAX = 12;
export const HOUSE_RULE_TEXT_MAX = 40;

/** メンバー情報（旧ハウスルール）。2026-09-25 からアイコンではなく見出し（任意）と文言 */
export const houseRulesSchema = z.object({
  rules: z
    .array(
      z.object({
        title: optionalText("見出し", HOUSE_RULE_TITLE_MAX),
        text: requiredText("メンバー情報の文言", HOUSE_RULE_TEXT_MAX),
      }),
    )
    .max(HOUSE_RULES_MAX, `メンバー情報は${HOUSE_RULES_MAX}件までです`),
});

// ---------------------------------------------------------------- 表示スケジュール

export const displayScheduleSchema = z.object({
  entries: z
    .array(
      z
        .object({
          weekday: weekdaySchema,
          startTime: hhmm,
          endTime: hhmm,
          enabled: z.boolean(),
        })
        .refine((e) => e.startTime !== e.endTime, {
          path: ["endTime"],
          message: "開始と終了に同じ時刻は指定できません",
        }),
    )
    .max(7)
    .refine((entries) => new Set(entries.map((e) => e.weekday)).size === entries.length, "同じ曜日が重複しています"),
});

// ---------------------------------------------------------------- 動画設定

export const videoSettingsInputSchema = z.object({
  enabled: z.boolean(),
  intervalMinutes: z.literal([...VIDEO_INTERVAL_MINUTES], "動画の間隔は一覧から選んでください"),
  mode: z.enum(["sequence", "random"]),
  /** 再生順に並べた動画の mediaId */
  mediaIds: z.array(z.string().min(1)),
  revision,
});

// ---------------------------------------------------------------- 端末 API

const sha256OrNull = z.string().regex(/^[0-9a-f]{64}$/).nullable();

export const heartbeatSchema = z.object({
  agentVersion: z.string().min(1).max(64),
  bundleId: z.string().min(1).max(128).nullable(),
  appliedVersion: sha256OrNull,
  pendingVersion: sha256OrNull,
  /** 再生状態機械の状態。off は表示時間外 */
  mode: z.enum(["display", "fading_out", "playing", "fading_in", "off"]),
  displayHealthy: z.boolean(),
  nextVideoAt: unixSeconds.nullable(),
  lastVideoFinishedAt: unixSeconds.nullable(),
  timeSynced: z.boolean(),
  diskFreeBytes: z.int().nonnegative(),
  cpuTempC: z.number().nullable(),
  memAvailableBytes: z.int().nonnegative().nullable(),
});

export const deviceLogsSchema = z.object({
  logs: z
    .array(
      z.object({
        type: z.string().min(1).max(64),
        message: z.string().max(2000),
        createdAt: unixSeconds,
      }),
    )
    .min(1)
    .max(DEVICE_LOGS_MAX),
});

export const mediaFailuresSchema = z.object({
  failures: z
    .array(
      z
        .object({
          /** 失敗したのが画像・動画なら mediaId、表示バンドルなら bundleId。どちらか一方だけを送る */
          mediaId: z.string().min(1).nullable().default(null),
          bundleId: z.string().min(1).nullable().default(null),
          reason: z.enum(["download_failed", "hash_mismatch", "playback_failed"]),
          /** 3 回不一致で隔離したとき true */
          quarantined: z.boolean(),
          occurredAt: unixSeconds,
        })
        .refine((f) => (f.mediaId === null) !== (f.bundleId === null), "mediaId と bundleId はどちらか一方だけを指定してください"),
    )
    .min(1)
    .max(MEDIA_FAILURES_MAX),
});

export type EventInput = z.infer<typeof eventInputSchema>;
export type EventUpdate = z.infer<typeof eventUpdateSchema>;
export type NoticeInput = z.infer<typeof noticeInputSchema>;
export type NoticeUpdate = z.infer<typeof noticeUpdateSchema>;
export type DesignSettingsInput = z.infer<typeof designSettingsSchema>;
export type HouseRulesInput = z.infer<typeof houseRulesSchema>;
export type DisplayScheduleInput = z.infer<typeof displayScheduleSchema>;
export type VideoSettingsInput = z.infer<typeof videoSettingsInputSchema>;
export type HeartbeatInput = z.infer<typeof heartbeatSchema>;
export type DeviceLogsInput = z.infer<typeof deviceLogsSchema>;
export type MediaFailuresInput = z.infer<typeof mediaFailuresSchema>;
