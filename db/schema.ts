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
import type { SpotlightSubmissionFile, SpotlightSubmissionPayload } from "../lib/spotlight-submissions";
import { SPOTLIGHT_PLACEHOLDER_EMAIL } from "../lib/validators";

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
  /** テスト表示で流す動画（管理画面で動画を選んで押したとき）。null なら再生リストの次の 1 本 */
  testPlayMediaId: text("test_play_media_id"),
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
    /** video は動画。slideshow は 1 枚目の写真（写真の並びと秒数は playlist_item_slides） */
    mediaId: text("media_id")
      .notNull()
      .references(() => media.id, { onDelete: "restrict" }),
    /** video = 動画 1 本、slideshow = 写真 1〜3 枚のスライドショー（2026-09-27 ユーザー指示。再生リストに 1 つまで） */
    kind: text("kind", { enum: ["video", "slideshow"] }).notNull().default("video"),
    position: integer("position").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("playlist_items_playlist_id_position_idx").on(t.playlistId, t.position)],
);

/** スライドショー（playlist_items.kind = slideshow）の写真。並び順に position 0..n-1、写真ごとの表示秒数 */
export const playlistItemSlides = sqliteTable(
  "playlist_item_slides",
  {
    id: id(),
    playlistItemId: text("playlist_item_id")
      .notNull()
      .references(() => playlistItems.id, { onDelete: "cascade" }),
    mediaId: text("media_id")
      .notNull()
      .references(() => media.id, { onDelete: "restrict" }),
    durationSeconds: integer("duration_seconds").notNull(),
    position: integer("position").notNull(),
  },
  (t) => [index("playlist_item_slides_item_id_position_idx").on(t.playlistItemId, t.position)],
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
  /** お知らせのカードの右に出す QR の飛び先（任意。2026-09-25 ユーザー指示） */
  qrUrl: text("qr_url"),
  enabled: bool("enabled").notNull().default(true),
  displayMode: text("display_mode", { enum: ["always", "timeRange"] }).notNull().default("always"),
  /** 日本時間 HH:MM（日またぎ可） */
  displayStartTime: text("display_start_time"),
  displayEndTime: text("display_end_time"),
  revision: revision(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * メンバー紹介（サイネージの MEMBER SPOTLIGHT。2026-09-26 ユーザー指示）。各企業のメンバーを 1 人ずつスライドで紹介する。
 * 並びは登録順。写真と会社のロゴは media（画像）を参照する
 */
export const memberSpotlights = sqliteTable("member_spotlights", {
  id: id(),
  companyName: text("company_name").notNull(),
  personName: text("person_name").notNull(),
  /**
   * ふりがな（任意。ひらがな・カタカナ）。漢字の名前は読みが分からないので、管理画面の一覧の あ行・か行… の絞り込みと
   * 名前順にだけ使う。サイネージには出さない（2026-09-27 ユーザー指示）
   */
  personNameKana: text("person_name_kana"),
  /** 肩書き（任意） */
  role: text("role"),
  /** ひとこと（任意。サイネージでは写真の上に、手書き風の文字で出す） */
  quote: text("quote"),
  /** 紹介文（任意） */
  bio: text("bio"),
  /** タグ（文字列の配列。最大 3 つ） */
  tags: text("tags", { mode: "json" }).$type<string[]>().notNull().$defaultFn(() => []),
  /**
   * メールアドレス（必須。管理画面で見るだけで、サイネージの config には入れない。2026-10-01 ユーザー指示）。
   * 本人登録で承認した人は申請のアドレスを引き継ぐ。それより前からいる人は届かない仮のアドレス
   */
  contactEmail: text("contact_email").notNull().default(SPOTLIGHT_PLACEHOLDER_EMAIL),
  photoMediaId: text("photo_media_id").references(() => media.id, { onDelete: "restrict" }),
  logoMediaId: text("logo_media_id").references(() => media.id, { onDelete: "restrict" }),
  enabled: bool("enabled").notNull().default(true),
  revision: revision(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** 承認前の申請は公開紹介・通常素材と分離する。R2保存前に追跡用の行を作成する。 */
export const memberSpotlightSubmissions = sqliteTable(
  "member_spotlight_submissions",
  {
    id: id(),
    requestKey: text("request_key").notNull().unique(),
    requestFingerprint: text("request_fingerprint").notNull(),
    /** 結果の通知専用。公開するpayloadやmember_spotlightsには写さない。 */
    contactEmail: text("contact_email"),
    notificationStatus: text("notification_status", { enum: ["pending", "sent", "failed", "skipped"] }),
    notificationAttempts: integer("notification_attempts").notNull().default(0),
    notifiedAt: integer("notified_at"),
    notificationNextAt: integer("notification_next_at"),
    /** 承認時はpayloadを消すため、通知が終わるまで宛名だけ保持する。 */
    notificationName: text("notification_name"),
    payload: text("payload", { mode: "json" }).$type<SpotlightSubmissionPayload>(),
    photoFile: text("photo_file", { mode: "json" }).$type<SpotlightSubmissionFile>(),
    logoFile: text("logo_file", { mode: "json" }).$type<SpotlightSubmissionFile>(),
    status: text("status", { enum: ["receiving", "pending", "approved", "rejected", "expired"] }).notNull().default("receiving"),
    revision: revision(),
    consentedAt: integer("consented_at").notNull(),
    consentVersion: integer("consent_version").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    submittedAt: integer("submitted_at"),
    reviewedAt: integer("reviewed_at"),
    reviewedBy: text("reviewed_by").references(() => users.id, { onDelete: "set null" }),
    approvedSpotlightId: text("approved_spotlight_id").unique().references(() => memberSpotlights.id, { onDelete: "set null" }),
    cleanupNextAt: integer("cleanup_next_at"),
    cleanupCompletedAt: integer("cleanup_completed_at"),
  },
  (t) => [
    check("member_spotlight_submissions_status_check", sql`${t.status} IN ('receiving', 'pending', 'approved', 'rejected', 'expired')`),
    index("member_spotlight_submissions_status_submitted_at_idx").on(t.status, t.submittedAt),
    index("member_spotlight_submissions_status_updated_at_idx").on(t.status, t.updatedAt),
    index("member_spotlight_submissions_cleanup_idx").on(t.cleanupNextAt, t.id)
      .where(sql`${t.status} IN ('rejected', 'expired') AND ${t.cleanupCompletedAt} IS NULL`),
    index("member_spotlight_submissions_notification_idx").on(t.notificationNextAt, t.id)
      .where(sql`${t.notificationStatus} = 'pending'`),
  ],
);

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
  /**
   * 明日から 3 日分の予報（JSON。lib/weather.ts の DailyForecast[]）。5 日・3 時間ごとの予報を日本時間の日ごとにまとめたもの。
   * 取れなかったときは前回の値のまま（2026-09-25 ユーザー指示「フッターの天気の横に明日・明後日の天気」）
   */
  forecast: text("forecast"),
});
