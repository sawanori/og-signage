/**
 * メディアのアップロード（uploads による状態管理）・一覧・削除予約・削除の実行。
 *
 * - キーはサーバーが決める（lib/r2.ts の mediaKeys）。クライアント指定のキーは受けない。
 * - 形式は先頭バイトで判定する（lib/file-sniff.ts）。1 パート目の受信時と complete 時の 2 回。
 * - complete は冪等。media.r2_key の UNIQUE で、再送・同時実行でも media は 1 件になる。
 *   R2 の complete が「完了済み」で失敗しても、R2 に本体があれば続きを進める（応答喪失・DB 失敗からの再送）。
 * - 削除は参照が無いことを確かめて state = deleting（1 つの UPDATE で判定するので、確認と更新の間に参照は入らない）。
 *   R2 からの削除と行の削除は Cron（task_013）が purgeDeletedMedia で行う。
 * - playable は当面、要件定義書 15 節の推奨（MP4・H.264・1080p 以下・30fps 以下・yuv420p）で判定する。
 *   task_003 の実測後に isPlayable を更新する。
 */
import { and, asc, desc, eq, isNotNull, lte, notExists, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../../db/index";
import { devices, events, houseSettings, media, mediaFailures, notices, playlistItems, uploads } from "../../db/schema";
import type { AuthUser } from "../auth";
import {
  MAX_VIDEO_SECONDS,
  MAX_VIDEOS,
  MEDIA_MAX_BYTES,
  SNIFF_BYTES,
  UPLOAD_PART_SIZE,
  isVideoTooLong,
  kindOfMime,
  sniffMime,
  type MediaKind,
} from "../file-sniff";
import { mediaKeys, type MediaBucket, type R2Part } from "../r2";

export const DELETE_DELAY_SECONDS = 7 * 24 * 60 * 60;
export const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024;

export type MediaRow = typeof media.$inferSelect;
export type MediaDeps = { db: Db; bucket: MediaBucket };

export class MediaError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409 | 413 | 415,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "MediaError";
  }
}

/** Route Handler 用。MediaError と入力エラーは JSON に、それ以外は投げ直す */
export function mediaErrorResponse(e: unknown): Response {
  if (e instanceof MediaError) {
    return Response.json({ error: { code: e.code, message: e.message } }, { status: e.status });
  }
  if (e instanceof z.ZodError) {
    const message = e.issues[0]?.message ?? "入力が正しくありません";
    return Response.json({ error: { code: "invalid_input", message } }, { status: 400 });
  }
  throw e;
}

// ---------------------------------------------------------------- 入力

export const videoCodecInfoSchema = z.object({
  container: z.literal("mp4"),
  /** サンプルエントリの 4 文字（avc1, avc3, hvc1 など） */
  codec: z.string().min(1).max(8),
  profile: z.number().int().nullable(),
  level: z.number().int().nullable(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  fps: z.number().positive().nullable(),
  chromaFormat: z.enum(["4:0:0", "4:2:0", "4:2:2", "4:4:4"]).nullable(),
  bitDepth: z.number().int().positive().nullable(),
});
export type VideoCodecInfo = z.infer<typeof videoCodecInfoSchema>;

export const startUploadSchema = z.object({
  kind: z.enum(["image", "video"], { message: "種類が正しくありません" }),
  size: z.number({ message: "ファイルの大きさが正しくありません" }).int().positive("空のファイルはアップロードできません"),
});
export type StartUploadInput = z.input<typeof startUploadSchema>;

const dimension = z.number().int().positive().max(20000).nullish();

export const completeUploadSchema = z.object({
  name: z.string().trim().min(1, "ファイル名がありません").max(200, "ファイル名が長すぎます"),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, "ハッシュが正しくありません"),
  parts: z
    .array(z.object({ partNumber: z.number().int().positive(), etag: z.string().min(1).max(200) }))
    .min(1)
    .max(Math.ceil(MEDIA_MAX_BYTES.video / UPLOAD_PART_SIZE)),
  width: dimension,
  height: dimension,
  durationSeconds: z.number().positive().max(24 * 60 * 60).nullish(),
  codecInfo: videoCodecInfoSchema.nullish(),
});
export type CompleteUploadInput = z.input<typeof completeUploadSchema>;

// ---------------------------------------------------------------- 再生可否

/** 要件定義書 15 節の推奨（task_003 の実測まで）。縦長の 1080x1920 も 1080p とみなす */
export function isPlayable(mimeType: string, info: VideoCodecInfo | null | undefined): boolean {
  if (mimeType !== "video/mp4" || !info) return false;
  const shortSide = Math.min(info.width, info.height);
  const longSide = Math.max(info.width, info.height);
  return (
    (info.codec === "avc1" || info.codec === "avc3") &&
    shortSide <= 1080 &&
    longSide <= 1920 &&
    info.fps !== null &&
    info.fps <= 30.01 &&
    info.chromaFormat === "4:2:0" &&
    info.bitDepth === 8
  );
}

// ---------------------------------------------------------------- アップロード

function sizeLimitMessage(kind: MediaKind): string {
  return kind === "video"
    ? "動画は 12MB 以下にしてください（20 秒の 1920×1080 なら、書き出しのビットレートを 4Mbps 程度に）"
    : "画像は 20MB 以下にしてください";
}

const VIDEO_LIMIT_MESSAGE = `動画は ${MAX_VIDEOS} 本までです。新しい動画を入れるには、「動画・メディア」で今ある動画を削除してください`;

/** 置いてある動画（削除中を除く）の本数 */
async function countActiveVideos(db: Db): Promise<number> {
  const rows = await db
    .select({ id: media.id })
    .from(media)
    .where(and(eq(media.type, "video"), eq(media.state, "active")));
  return rows.length;
}

const partCountOf = (size: number) => Math.ceil(size / UPLOAD_PART_SIZE);

function expectedPartLength(declaredSize: number, partNumber: number): number {
  const count = partCountOf(declaredSize);
  return partNumber < count ? UPLOAD_PART_SIZE : declaredSize - UPLOAD_PART_SIZE * (count - 1);
}

async function loadOwnUpload(db: Db, user: AuthUser, uploadId: string) {
  const [upload] = await db.select().from(uploads).where(eq(uploads.id, uploadId));
  if (!upload) throw new MediaError(404, "not_found", "アップロードが見つかりません");
  if (upload.userId !== user.id) throw new MediaError(403, "forbidden", "このアップロードを操作する権限がありません");
  return upload;
}

function checkMime(head: Uint8Array, kind: MediaKind) {
  const mime = sniffMime(head);
  if (!mime || kindOfMime(mime) !== kind) {
    throw new MediaError(415, "unsupported_type", "対応していない形式です（画像は JPEG・PNG・WebP、動画は MP4）");
  }
  return mime;
}

export async function startUpload(
  { db, bucket }: MediaDeps,
  user: AuthUser,
  input: StartUploadInput,
): Promise<{ uploadId: string; partSize: number }> {
  const { kind, size } = startUploadSchema.parse(input);
  if (size > MEDIA_MAX_BYTES[kind]) throw new MediaError(413, "too_large", sizeLimitMessage(kind));
  if (kind === "video" && (await countActiveVideos(db)) >= MAX_VIDEOS) {
    throw new MediaError(409, "video_limit", VIDEO_LIMIT_MESSAGE);
  }

  const uploadId = crypto.randomUUID();
  const key = mediaKeys(uploadId).original;
  const mpu = await bucket.createMultipartUpload(key);
  await db.insert(uploads).values({ id: uploadId, userId: user.id, kind, r2Key: key, r2UploadId: mpu.uploadId, declaredSize: size });
  return { uploadId, partSize: UPLOAD_PART_SIZE };
}

async function readAll(body: ReadableStream<Uint8Array>, limit: number): Promise<Uint8Array> {
  const out = new Uint8Array(limit);
  let length = 0;
  const reader = body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (length + value.length > limit) {
      await reader.cancel();
      throw new MediaError(400, "invalid_part", "パートの大きさが正しくありません");
    }
    out.set(value, length);
    length += value.length;
  }
  return out.subarray(0, length);
}

/**
 * 1 パートを R2 に送る。パートの大きさは宣言サイズから決まる値ちょうどでなければ拒否する
 * （パートの合計が宣言サイズを超えない）。1 パート目は先頭バイトで形式を検査し、不正ならアップロードを中断する。
 */
export async function uploadPart(
  { db, bucket }: MediaDeps,
  user: AuthUser,
  uploadId: string,
  partNumber: number,
  body: ReadableStream<Uint8Array> | null,
  contentLength: number | null,
): Promise<R2Part> {
  const upload = await loadOwnUpload(db, user, uploadId);
  if (upload.state !== "uploading") throw new MediaError(409, "not_uploading", "このアップロードは終了しています");
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > partCountOf(upload.declaredSize)) {
    throw new MediaError(400, "invalid_part", "パート番号が正しくありません");
  }
  const expected = expectedPartLength(upload.declaredSize, partNumber);
  if (!body || contentLength !== expected) throw new MediaError(400, "invalid_part", "パートの大きさが正しくありません");

  const mpu = bucket.resumeMultipartUpload(upload.r2Key, upload.r2UploadId);
  if (partNumber !== 1) return mpu.uploadPart(partNumber, body);

  const bytes = await readAll(body, expected);
  if (bytes.length !== expected) throw new MediaError(400, "invalid_part", "パートの大きさが正しくありません");
  try {
    checkMime(bytes.subarray(0, SNIFF_BYTES), upload.kind);
  } catch (e) {
    await abortUpload({ db, bucket }, user, uploadId);
    throw e;
  }
  return mpu.uploadPart(1, bytes);
}

/** R2 のマルチパートを閉じる。すでに閉じていて本体があれば（再送・同時実行）そのまま進む */
async function completeR2(bucket: MediaBucket, key: string, r2UploadId: string, parts: R2Part[]) {
  try {
    await bucket.resumeMultipartUpload(key, r2UploadId).complete(parts);
  } catch (e) {
    if (!(await bucket.head(key))) {
      console.warn("R2 multipart complete failed", e);
      throw new MediaError(409, "upload_incomplete", "アップロードが完了していません。もう一度お試しください");
    }
  }
  const head = await bucket.head(key);
  if (!head) throw new MediaError(409, "upload_incomplete", "アップロードが完了していません。もう一度お試しください");
  return head;
}

/**
 * 完了。冪等（同じアップロードの再送・同時実行は同じ media を返す）。
 * R2 上のサイズを宣言サイズと照合し、先頭バイトを読み直して MIME を決める。
 */
export async function completeUpload(
  { db, bucket }: MediaDeps,
  user: AuthUser,
  uploadId: string,
  input: CompleteUploadInput,
  thumbnail: Uint8Array | null = null,
): Promise<MediaRow> {
  const meta = completeUploadSchema.parse(input);
  const upload = await loadOwnUpload(db, user, uploadId);
  if (upload.state === "aborted") throw new MediaError(409, "aborted", "このアップロードは中断されています");
  if (upload.state === "completed" && upload.mediaId) return getMediaOrThrow(db, upload.mediaId);

  if (upload.kind === "video" && upload.state === "uploading") {
    // 動画の尺は 20 秒まで（長さはブラウザが MP4 から読んで送る）。断るときは R2 の途中のアップロードも捨てる
    if (meta.durationSeconds === null || meta.durationSeconds === undefined || isVideoTooLong(meta.durationSeconds)) {
      await abortUpload({ db, bucket }, user, uploadId);
      throw new MediaError(
        400,
        "video_too_long",
        meta.durationSeconds === null || meta.durationSeconds === undefined
          ? "動画の長さを読み取れませんでした。MP4 の動画をお使いください"
          : `動画は ${MAX_VIDEO_SECONDS} 秒以内にしてください（この動画は ${Math.round(meta.durationSeconds)} 秒です）`,
      );
    }
    // 開始のあとに別の動画が入って上限に達していたら、R2 の途中のアップロードを捨てて断る
    if ((await countActiveVideos(db)) >= MAX_VIDEOS) {
      await abortUpload({ db, bucket }, user, uploadId);
      throw new MediaError(409, "video_limit", VIDEO_LIMIT_MESSAGE);
    }
  }

  const count = partCountOf(upload.declaredSize);
  const parts = [...meta.parts].sort((a, b) => a.partNumber - b.partNumber);
  if (parts.length !== count || parts.some((p, i) => p.partNumber !== i + 1)) {
    throw new MediaError(400, "invalid_parts", "すべてのパートを送ってから完了してください");
  }

  const head = await completeR2(bucket, upload.r2Key, upload.r2UploadId, parts);
  if (head.size !== upload.declaredSize) {
    throw new MediaError(400, "size_mismatch", "ファイルの大きさが一致しません。もう一度アップロードしてください");
  }
  if (head.size > MEDIA_MAX_BYTES[upload.kind]) throw new MediaError(413, "too_large", sizeLimitMessage(upload.kind));

  const first = await bucket.get(upload.r2Key, { range: { offset: 0, length: SNIFF_BYTES } });
  if (!first) throw new MediaError(409, "upload_incomplete", "アップロードが完了していません。もう一度お試しください");
  const mimeType = checkMime(new Uint8Array(await first.arrayBuffer()), upload.kind);

  let thumbnailR2Key: string | null = null;
  if (thumbnail) {
    const thumbMime = sniffMime(thumbnail.subarray(0, SNIFF_BYTES));
    if (thumbMime !== "image/webp" || thumbnail.length > THUMBNAIL_MAX_BYTES) {
      throw new MediaError(415, "invalid_thumbnail", "サムネイルの形式が正しくありません");
    }
    thumbnailR2Key = mediaKeys(uploadId).thumbnail;
    await bucket.put(thumbnailR2Key, thumbnail, { httpMetadata: { contentType: "image/webp" } });
  }

  const codecInfo = upload.kind === "video" ? (meta.codecInfo ?? null) : null;
  await db
    .insert(media)
    .values({
      name: meta.name,
      type: upload.kind,
      r2Key: upload.r2Key,
      thumbnailR2Key,
      mimeType,
      width: meta.width ?? codecInfo?.width ?? null,
      height: meta.height ?? codecInfo?.height ?? null,
      durationSeconds: upload.kind === "video" ? (meta.durationSeconds ?? null) : null,
      fileSize: head.size,
      sha256: meta.sha256,
      codecInfo,
      playable: upload.kind === "video" && isPlayable(mimeType, codecInfo),
    })
    .onConflictDoNothing({ target: media.r2Key });

  const [row] = await db.select().from(media).where(eq(media.r2Key, upload.r2Key));
  await db.update(uploads).set({ state: "completed", mediaId: row.id }).where(eq(uploads.id, uploadId));
  return row;
}

/** 中断。完了済みは 409、中断済みはそのまま成功 */
export async function abortUpload({ db, bucket }: MediaDeps, user: AuthUser, uploadId: string): Promise<void> {
  const upload = await loadOwnUpload(db, user, uploadId);
  if (upload.state === "completed") throw new MediaError(409, "completed", "完了したアップロードは中断できません");
  if (upload.state === "aborted") return;
  try {
    await bucket.resumeMultipartUpload(upload.r2Key, upload.r2UploadId).abort();
  } catch (e) {
    // R2 側がすでに無い場合も中断済みとして扱う。残りは未完了アップロードの掃除（task_013）が拾う
    console.warn("R2 multipart abort failed", e);
  }
  await db
    .update(uploads)
    .set({ state: "aborted" })
    .where(and(eq(uploads.id, uploadId), eq(uploads.state, "uploading")));
}

// ---------------------------------------------------------------- 一覧・取得

/** API の応答。R2 のキーは外に出さない */
export function toMediaDto(row: MediaRow) {
  return {
    id: row.id,
    name: row.name,
    type: row.type,
    mimeType: row.mimeType,
    width: row.width,
    height: row.height,
    durationSeconds: row.durationSeconds,
    fileSize: row.fileSize,
    sha256: row.sha256,
    codecInfo: row.codecInfo,
    playable: row.playable,
    hasThumbnail: row.thumbnailR2Key !== null,
    createdAt: row.createdAt,
  };
}
export type MediaDto = ReturnType<typeof toMediaDto>;

async function getMediaOrThrow(db: Db, id: string): Promise<MediaRow> {
  const [row] = await db.select().from(media).where(eq(media.id, id));
  if (!row) throw new MediaError(404, "not_found", "メディアが見つかりません");
  return row;
}

/** 管理画面の一覧（削除予約中は出さない） */
export async function listMedia(db: Db): Promise<MediaRow[]> {
  return db.select().from(media).where(eq(media.state, "active")).orderBy(desc(media.createdAt), asc(media.id));
}

/** 管理用素材中継の対象。削除予約中・存在しないものは null */
export async function getActiveMedia(db: Db, id: string): Promise<MediaRow | null> {
  const [row] = await db
    .select()
    .from(media)
    .where(and(eq(media.id, id), eq(media.state, "active")));
  return row ?? null;
}

export type MediaFailureSummary = {
  mediaId: string;
  deviceId: string;
  deviceName: string;
  reason: "download_failed" | "hash_mismatch" | "playback_failed";
  quarantined: boolean;
  count: number;
  lastAt: number;
};

/** 端末が報告した画像・動画の失敗（表示バンドルの失敗は除く）。新しい報告から順に */
export async function listMediaFailures(db: Db): Promise<MediaFailureSummary[]> {
  const rows = await db
    .select({
      mediaId: mediaFailures.mediaId,
      deviceId: mediaFailures.deviceId,
      deviceName: devices.name,
      reason: mediaFailures.reason,
      quarantined: mediaFailures.quarantined,
      count: mediaFailures.count,
      lastAt: mediaFailures.lastAt,
    })
    .from(mediaFailures)
    .innerJoin(devices, eq(mediaFailures.deviceId, devices.id))
    .where(isNotNull(mediaFailures.mediaId))
    .orderBy(desc(mediaFailures.lastAt), asc(mediaFailures.id));
  return rows.map((row) => ({ ...row, mediaId: row.mediaId! }));
}

// ---------------------------------------------------------------- 削除

const one = sql`1`;

/** 参照（イベント・お知らせ・デザイン設定のロゴとフッター・プレイリスト）が無ければ削除予約する */
export async function requestMediaDeletion(db: Db, id: string, now: number): Promise<void> {
  const updated = await db
    .update(media)
    .set({ state: "deleting", deleteAfter: now + DELETE_DELAY_SECONDS })
    .where(
      and(
        eq(media.id, id),
        eq(media.state, "active"),
        notExists(db.select({ x: one }).from(events).where(eq(events.imageMediaId, id))),
        notExists(db.select({ x: one }).from(notices).where(eq(notices.imageMediaId, id))),
        notExists(db.select({ x: one }).from(houseSettings).where(eq(houseSettings.logoMediaId, id))),
        notExists(db.select({ x: one }).from(houseSettings).where(eq(houseSettings.footerImageMediaId, id))),
        notExists(db.select({ x: one }).from(playlistItems).where(eq(playlistItems.mediaId, id))),
      ),
    )
    .returning({ id: media.id });
  if (updated.length > 0) return;

  const row = await getMediaOrThrow(db, id);
  if (row.state === "deleting") return;
  throw new MediaError(
    409,
    "in_use",
    "使用中のため削除できません。イベント・お知らせ・デザイン設定・プレイリストから外してから削除してください",
  );
}

/**
 * 削除予約の期限を過ぎた media を R2 から消し、行を消す（Cron から呼ぶ。task_013）。
 * R2 の削除に失敗したものは行を残し、次回に再試行する。
 */
export async function purgeDeletedMedia(
  { db, bucket }: MediaDeps,
  now: number,
): Promise<{ purged: string[]; failed: string[] }> {
  const due = await db
    .select()
    .from(media)
    .where(and(eq(media.state, "deleting"), lte(media.deleteAfter, now)));
  const purged: string[] = [];
  const failed: string[] = [];
  for (const row of due) {
    try {
      await bucket.delete(row.thumbnailR2Key ? [row.r2Key, row.thumbnailR2Key] : [row.r2Key]);
      await db.delete(media).where(and(eq(media.id, row.id), eq(media.state, "deleting")));
      purged.push(row.id);
    } catch (e) {
      console.warn("media purge failed", row.id, e);
      failed.push(row.id);
    }
  }
  return { purged, failed };
}
