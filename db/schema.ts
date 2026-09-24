/**
 * DB スキーマ（Turso / libSQL）。計画 10 節と要件定義書 34 節に対応する。
 *
 * - ID は text。新規行は crypto.randomUUID()（Workers と Node の両方にある）。
 * - 時刻は UNIX 秒の integer。
 * - 真偽値は integer（0/1）。
 * - 画像参照と playlist_items.media_id は ON DELETE RESTRICT。参照中の media は消せない。
 * - 値の範囲は lib/config-schema.ts・lib/validators.ts に合わせる。
 */
import { sql } from "drizzle-orm";
import { check, index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

export const nowSeconds = () => Math.floor(Date.now() / 1000);

const createdAt = () => integer("created_at").notNull().$defaultFn(nowSeconds);
const updatedAt = () => integer("updated_at").notNull().$defaultFn(nowSeconds);
/** 楽観ロック。更新のたびに 1 増やし、送られた値と一致しなければ 409 */
const revision = () => integer("revision").notNull().default(0);
const bool = (name: string) => integer(name, { mode: "boolean" });

// ---------------------------------------------------------------- 管理ユーザー

export const users = sqliteTable("users", {
  id: id(),
  email: text("email").notNull().unique(),
  name: text("name"),
  passwordHash: text("password_hash"),
  role: text("role", { enum: ["staff", "administrator"] }).notNull().default("staff"),
  isActive: bool("is_active").notNull().default(true),
  /** 増やすと既存セッションが無効になる（役割変更・無効化・パスワード変更時） */
  sessionVersion: integer("session_version").notNull().default(0),
  /** ログインの連続失敗回数（lib/rate-limit.ts）。成功で 0 に戻す */
  failedLoginCount: integer("failed_login_count").notNull().default(0),
  /** 連続失敗を数え始めた時刻。この時刻から 15 分で数え直す */
  failedLoginWindowStart: integer("failed_login_window_start"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------- メディア

export const media = sqliteTable(
  "media",
  {
    id: id(),
    name: text("name").notNull(),
    type: text("type", { enum: ["image", "video"] }).notNull(),
    r2Key: text("r2_key").notNull().unique(),
    thumbnailR2Key: text("thumbnail_r2_key"),
    mimeType: text("mime_type"),
    width: integer("width"),
    height: integer("height"),
    /** config の durationSeconds（小数あり）に合わせて real */
    durationSeconds: real("duration_seconds"),
    fileSize: integer("file_size"),
    /** 小文字16進64桁 */
    sha256: text("sha256"),
    /** ブラウザで取得したコーデック情報（JSON） */
    codecInfo: text("codec_info", { mode: "json" }).$type<Record<string, unknown>>(),
    /** Pi で再生できる条件（task_003）を満たすか。画像は常に false */
    playable: bool("playable").notNull().default(false),
    /** deleting は削除予約中。新規参照を禁止し、delete_after を過ぎたら Cron が消す */
    state: text("state", { enum: ["active", "deleting"] }).notNull().default("active"),
    deleteAfter: integer("delete_after"),
    createdAt: createdAt(),
  },
  (t) => [index("media_state_delete_after_idx").on(t.state, t.deleteAfter)],
);

export const uploads = sqliteTable("uploads", {
  id: id(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  kind: text("kind", { enum: ["image", "video"] }).notNull(),
  r2Key: text("r2_key").notNull().unique(),
  r2UploadId: text("r2_upload_id").notNull(),
  declaredSize: integer("declared_size").notNull(),
  state: text("state", { enum: ["uploading", "completed", "aborted"] }).notNull().default("uploading"),
  mediaId: text("media_id").references(() => media.id, { onDelete: "set null" }),
  createdAt: createdAt(),
});

// ---------------------------------------------------------------- イベント

export const eventCategories = sqliteTable("event_categories", {
  id: id(),
  name: text("name").notNull(),
  /** #RRGGBB */
  color: text("color").notNull(),
  position: integer("position").notNull(),
});

export const events = sqliteTable(
  "events",
  {
    id: id(),
    title: text("title").notNull(),
    description: text("description"),
    location: text("location"),
    startAt: integer("start_at").notNull(),
    endAt: integer("end_at"),
    imageMediaId: text("image_media_id").references(() => media.id, { onDelete: "restrict" }),
    qrUrl: text("qr_url"),
    categoryId: text("category_id").references(() => eventCategories.id),
    emoji: text("emoji"),
    hostName: text("host_name"),
    catchCopy: text("catch_copy"),
    /** free = 参加自由・予約不要、limited = 定員あり（要件の reservation_required を置き換え） */
    participation: text("participation", { enum: ["free", "limited"] }).notNull().default("free"),
    capacity: integer("capacity"),
    participantCount: integer("participant_count"),
    status: text("status", { enum: ["published", "draft"] }).notNull().default("published"),
    revision: revision(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("events_status_start_at_idx").on(t.status, t.startAt)],
);

// ---------------------------------------------------------------- 端末

export const devices = sqliteTable("devices", {
  id: id(),
  name: text("name").notNull(),
  /** 端末トークン（32 バイト乱数）の SHA-256。平文は保存しない */
  tokenHash: text("token_hash").notNull().unique(),
  orientation: text("orientation", { enum: ["portrait", "landscape"] }).notNull().default("portrait"),
  resolutionWidth: integer("resolution_width").notNull().default(1080),
  resolutionHeight: integer("resolution_height").notNull().default(1920),
  /** 0〜100。初期値 0（ミュート） */
  volume: integer("volume").notNull().default(0),
  testPlayRequestedAt: integer("test_play_requested_at"),
  lastSeenAt: integer("last_seen_at"),
  // Heartbeat の最新値（lib/validators.ts の heartbeatSchema）
  agentVersion: text("agent_version"),
  bundleId: text("bundle_id"),
  appliedVersion: text("applied_version"),
  pendingVersion: text("pending_version"),
  mode: text("mode", { enum: ["display", "fading_out", "playing", "fading_in", "off"] }),
  displayHealthy: bool("display_healthy"),
  nextVideoAt: integer("next_video_at"),
  lastVideoFinishedAt: integer("last_video_finished_at"),
  timeSynced: bool("time_synced"),
  diskFreeBytes: integer("disk_free_bytes"),
  cpuTempC: real("cpu_temp_c"),
  memAvailableBytes: integer("mem_available_bytes"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const deviceLogs = sqliteTable(
  "device_logs",
  {
    id: id(),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    message: text("message"),
    createdAt: createdAt(),
  },
  (t) => [index("device_logs_device_id_created_at_idx").on(t.deviceId, t.createdAt)],
);

// ---------------------------------------------------------------- 表示バンドル

export const displayBundles = sqliteTable(
  "display_bundles",
  {
    id: id(),
    sha256: text("sha256").notNull(),
    size: integer("size").notNull(),
    r2Key: text("r2_key").notNull().unique(),
    schemaVersion: integer("schema_version").notNull(),
    publishedAt: integer("published_at").notNull().$defaultFn(nowSeconds),
    isCurrent: bool("is_current").notNull().default(false),
  },
  // 現行のバンドルは 1 件だけ
  (t) => [uniqueIndex("display_bundles_current_idx").on(t.isCurrent).where(sql`${t.isCurrent} = 1`)],
);

/** Pi が報告した取得・再生の失敗。対象は media か表示バンドルのどちらか一方 */
export const mediaFailures = sqliteTable(
  "media_failures",
  {
    id: id(),
    deviceId: text("device_id")
      .notNull()
      .references(() => devices.id, { onDelete: "cascade" }),
    mediaId: text("media_id").references(() => media.id, { onDelete: "cascade" }),
    bundleId: text("bundle_id").references(() => displayBundles.id, { onDelete: "cascade" }),
    reason: text("reason", { enum: ["download_failed", "hash_mismatch", "playback_failed"] }).notNull(),
    /** 3 回不一致で Pi が隔離したとき true */
    quarantined: bool("quarantined").notNull().default(false),
    count: integer("count").notNull().default(1),
    lastAt: integer("last_at").notNull(),
  },
  (t) => [
    check("media_failures_target_check", sql`(${t.mediaId} IS NULL) <> (${t.bundleId} IS NULL)`),
    uniqueIndex("media_failures_device_media_reason_idx").on(t.deviceId, t.mediaId, t.reason),
    uniqueIndex("media_failures_device_bundle_reason_idx").on(t.deviceId, t.bundleId, t.reason),
  ],
);

// ---------------------------------------------------------------- 動画

export const playlists = sqliteTable("playlists", {
  id: id(),
  name: text("name").notNull(),
  enabled: bool("enabled").notNull().default(true),
  revision: revision(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const playlistItems = sqliteTable(
  "playlist_items",
  {
    id: id(),
    playlistId: text("playlist_id")
      .notNull()
      .references(() => playlists.id, { onDelete: "cascade" }),
    mediaId: text("media_id")
      .notNull()
      .references(() => media.id, { onDelete: "restrict" }),
    position: integer("position").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("playlist_items_playlist_id_position_idx").on(t.playlistId, t.position)],
);

export const videoPlaybackSettings = sqliteTable("video_playback_settings", {
  id: id(),
  deviceId: text("device_id")
    .notNull()
    .unique()
    .references(() => devices.id),
  playlistId: text("playlist_id").references(() => playlists.id),
  enabled: bool("enabled").notNull().default(true),
  /** lib/config-schema.ts の VIDEO_INTERVAL_MINUTES のいずれか */
  intervalMinutes: integer("interval_minutes").notNull().default(10),
  playbackMode: text("playback_mode", { enum: ["sequence", "random"] }).notNull().default("sequence"),
  fullscreen: bool("fullscreen").notNull().default(true),
  fadeDurationMs: integer("fade_duration_ms").notNull().default(500),
  revision: revision(),
  updatedAt: updatedAt(),
});

// ---------------------------------------------------------------- お知らせ・デザイン設定

export const notices = sqliteTable("notices", {
  id: id(),
  title: text("title").notNull(),
  body: text("body"),
  imageMediaId: text("image_media_id").references(() => media.id, { onDelete: "restrict" }),
  enabled: bool("enabled").notNull().default(true),
  displayMode: text("display_mode", { enum: ["always", "timeRange"] }).notNull().default("always"),
  /** 日本時間 HH:MM（日またぎ可） */
  displayStartTime: text("display_start_time"),
  displayEndTime: text("display_end_time"),
  revision: revision(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** 1 行だけ */
export const houseSettings = sqliteTable("house_settings", {
  id: id(),
  houseName: text("house_name").notNull(),
  logoMediaId: text("logo_media_id").references(() => media.id, { onDelete: "restrict" }),
  headerCopy: text("header_copy"),
  footerCopy: text("footer_copy"),
  footerImageMediaId: text("footer_image_media_id").references(() => media.id, { onDelete: "restrict" }),
  /** フッターの QR コードの飛び先（http / https。例: 会議室予約のページ）。未設定ならフッターに QR の場所だけ空けておく */
  footerQrUrl: text("footer_qr_url"),
  weatherLocationName: text("weather_location_name"),
  weatherLatitude: real("weather_latitude"),
  weatherLongitude: real("weather_longitude"),
  revision: revision(),
  updatedAt: updatedAt(),
});

/** メンバー情報（旧ハウスルール）の項目。サイネージには見出しと文言を出す */
export const houseRules = sqliteTable("house_rules", {
  id: id(),
  /**
   * 旧: Lucide のアイコン名。2026-09-25 からアイコンは出さない（見出しに置き換え）。
   * 古い表示バンドルとの互換のため列と config の項目は残す。新しく保存する行は "info"
   */
  icon: text("icon").notNull(),
  /** 見出し（任意）。アイコンの代わりに出す */
  title: text("title"),
  text: text("text").notNull(),
  position: integer("position").notNull(),
});

/** 曜日ごとの表示時間帯。行がない曜日は終日表示 */
export const displaySchedules = sqliteTable(
  "display_schedules",
  {
    /** 0 = 日曜 … 6 = 土曜 */
    weekday: integer("weekday").primaryKey(),
    /** 日本時間 HH:MM。start_time > end_time は翌日の end_time まで */
    startTime: text("start_time").notNull(),
    endTime: text("end_time").notNull(),
    /** false はその曜日を終日表示しない */
    enabled: bool("enabled").notNull().default(true),
  },
  (t) => [check("display_schedules_weekday_check", sql`${t.weekday} BETWEEN 0 AND 6`)],
);

/** 天気の取得結果（1 行だけ） */
export const weatherCache = sqliteTable("weather_cache", {
  id: id(),
  locationName: text("location_name").notNull(),
  temperatureC: real("temperature_c").notNull(),
  /** OpenWeatherMap の weather[0].main を小文字化したもの */
  condition: text("condition").notNull(),
  fetchedAt: integer("fetched_at").notNull(),
});
