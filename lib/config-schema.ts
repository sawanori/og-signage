/**
 * 端末へ配る config（GET /api/device/config）の型。
 *
 * - 時刻はすべて UNIX 秒（整数）。判定は lib/dates.ts の Asia/Tokyo 基準。
 * - 画像・動画は mediaId と sha256 で参照し、URL は持たない。
 *   表示側は外から渡された解決関数で URL を決める（クラウドは管理用素材 API、Pi は /local/media/<sha256>）。
 * - Pi 側（Python）も同じ項目名で読むため、名前を変えるときは raspberry-pi/agent も合わせる。
 */
import { z } from "zod";
import { isHHMM } from "./dates";

export const SCHEMA_VERSION = 1 as const;

export const VIDEO_INTERVAL_MINUTES = [5, 10, 15, 20, 30, 60] as const;

const unixSeconds = z.int().nonnegative();
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "sha256 は小文字16進64桁");
const hhmm = z.string().refine(isHHMM, "HH:MM 形式");
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, "#RRGGBB 形式");

export const mediaRefSchema = z.object({
  mediaId: z.string().min(1),
  sha256: sha256Hex,
  /** バイト数。Pi が空き容量の見積もりと取得後の照合に使う */
  size: z.int().nonnegative(),
});

export const eventCategorySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  color: hexColor,
});

export const eventStatusSchema = z.enum(["published", "draft"]);
/** 参加形態。free = 参加自由・予約不要、limited = 定員あり */
export const participationSchema = z.enum(["free", "limited"]);

export const signageEventSchema = z.object({
  id: z.string().min(1),
  /** config には published だけが入る。管理画面プレビューと規則を共用するため型には残す */
  status: eventStatusSchema,
  title: z.string().min(1),
  description: z.string().nullable(),
  location: z.string().nullable(),
  startAt: unixSeconds,
  /** null は開始日の 23:59:59 に終わるものとして扱う */
  endAt: unixSeconds.nullable(),
  category: eventCategorySchema.nullable(),
  emoji: z.string().nullable(),
  hostName: z.string().nullable(),
  catchCopy: z.string().nullable(),
  participation: participationSchema,
  capacity: z.int().positive().nullable(),
  participantCount: z.int().nonnegative().nullable(),
  qrUrl: z.string().nullable(),
  image: mediaRefSchema.nullable(),
  createdAt: unixSeconds,
});

export const noticeDisplayModeSchema = z.enum(["always", "timeRange"]);

export const signageNoticeSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  body: z.string().nullable(),
  image: mediaRefSchema.nullable(),
  enabled: z.boolean(),
  displayMode: noticeDisplayModeSchema,
  /** displayMode = timeRange のときの時間帯（日本時間、HH:MM、日またぎ可） */
  displayStartTime: hhmm.nullable(),
  displayEndTime: hhmm.nullable(),
  updatedAt: unixSeconds,
});

/** メンバー情報（旧ハウスルール）の項目 */
export const houseRuleSchema = z.object({
  /** 旧: Lucide のアイコン名。表示には使わない（古い表示バンドルが読めるよう送り続ける） */
  icon: z.string().min(1),
  /** 見出し（任意。アイコンの代わりに出す）。古い Worker の config には無い */
  title: z.string().nullable().optional(),
  text: z.string().min(1),
});

export const houseSchema = z.object({
  name: z.string().min(1),
  headerCopy: z.string().nullable(),
  footerCopy: z.string().nullable(),
  /** フッターの QR コードの飛び先（例: 会議室予約のページ）。古い Worker の config には無い */
  footerQrUrl: z.string().nullable().optional(),
  logo: mediaRefSchema.nullable(),
  footerImage: mediaRefSchema.nullable(),
  /** 表示順に並べたもの */
  rules: z.array(houseRuleSchema),
});

/** 0 = 日曜 … 6 = 土曜 */
export const weekdaySchema = z.literal([0, 1, 2, 3, 4, 5, 6]);

export const scheduleEntrySchema = z.object({
  weekday: weekdaySchema,
  /** 日本時間 HH:MM。startTime > endTime は翌日の endTime まで */
  startTime: hhmm,
  endTime: hhmm,
  /** false はその曜日を終日表示しない */
  enabled: z.boolean(),
});

export const weatherSchema = z.object({
  locationName: z.string(),
  temperatureC: z.number(),
  /** OpenWeatherMap の天気コード（weather[0].main を小文字化したもの） */
  condition: z.string(),
  fetchedAt: unixSeconds,
});

export const playlistItemSchema = mediaRefSchema.extend({
  durationSeconds: z.number().positive(),
});

export const videoIntervalSchema = z.literal([...VIDEO_INTERVAL_MINUTES]);

export const videoSettingsSchema = z.object({
  enabled: z.boolean(),
  intervalMinutes: videoIntervalSchema,
  mode: z.enum(["sequence", "random"]),
});

export const displayBundleSchema = z.object({
  id: z.string().min(1),
  sha256: sha256Hex,
  size: z.int().nonnegative(),
});

export const deviceSettingsSchema = z.object({
  orientation: z.enum(["portrait", "landscape"]),
  width: z.int().positive(),
  height: z.int().positive(),
  /** 0〜100。初期値 0（ミュート） */
  volume: z.int().min(0).max(100),
});

export const commandsSchema = z.object({
  /** テスト表示の要求時刻。前回処理した値より新しければ次の動画を1本すぐ再生する */
  testPlayRequestedAt: unixSeconds.nullable(),
  /** テスト表示で流す動画（管理画面で動画を選んで押したとき）。null・無しなら再生リストの次の 1 本。古い Worker の config には無い */
  testPlayMediaId: z.string().nullable().optional(),
});

export const signageConfigSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  /** config 本体の SHA-256（小文字16進） */
  version: sha256Hex,
  events: z.array(signageEventSchema),
  notices: z.array(signageNoticeSchema),
  house: houseSchema,
  schedule: z.array(scheduleEntrySchema),
  weather: weatherSchema.nullable(),
  video: videoSettingsSchema,
  playlist: z.array(playlistItemSchema),
  displayBundle: displayBundleSchema,
  device: deviceSettingsSchema,
  commands: commandsSchema,
});

export type MediaRef = z.infer<typeof mediaRefSchema>;
export type EventCategory = z.infer<typeof eventCategorySchema>;
export type SignageEvent = z.infer<typeof signageEventSchema>;
export type SignageNotice = z.infer<typeof signageNoticeSchema>;
export type HouseRule = z.infer<typeof houseRuleSchema>;
export type House = z.infer<typeof houseSchema>;
export type ScheduleEntry = z.infer<typeof scheduleEntrySchema>;
export type Weather = z.infer<typeof weatherSchema>;
export type PlaylistItem = z.infer<typeof playlistItemSchema>;
export type VideoSettings = z.infer<typeof videoSettingsSchema>;
export type VideoIntervalMinutes = z.infer<typeof videoIntervalSchema>;
export type DisplayBundle = z.infer<typeof displayBundleSchema>;
export type DeviceSettings = z.infer<typeof deviceSettingsSchema>;
export type SignageConfig = z.infer<typeof signageConfigSchema>;

export type MediaRefEntry = MediaRef & { kind: "image" | "video" };

/**
 * config が参照する画像・動画を mediaId で重複を除いて列挙する（Pi のマニフェスト用）。
 * 表示バンドルは別枠（displayBundle）なので含めない。
 */
export function collectMediaRefs(config: SignageConfig): MediaRefEntry[] {
  const byId = new Map<string, MediaRefEntry>();
  const add = (ref: MediaRef | null, kind: MediaRefEntry["kind"]) => {
    if (ref && !byId.has(ref.mediaId)) {
      byId.set(ref.mediaId, { mediaId: ref.mediaId, sha256: ref.sha256, size: ref.size, kind });
    }
  };

  add(config.house.logo, "image");
  add(config.house.footerImage, "image");
  for (const event of config.events) add(event.image, "image");
  for (const notice of config.notices) add(notice.image, "image");
  for (const item of config.playlist) add(item, "video");

  return [...byId.values()];
}
