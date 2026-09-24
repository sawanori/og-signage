/**
 * Cron Trigger の本体（task_013）。worker/index.ts の `scheduled` から呼ぶ。
 *
 * - `*​/30 * * * *`: 天気の取得（lib/weather.ts）。
 * - `0 19 * * *`（日本時間 4:00）: 削除予約が過ぎた media を R2 と行から消す（purgeDeletedMedia）、
 *   24 時間以上 uploading のままの uploads を R2 の abortMultipartUpload と aborted に、
 *   30 日より古い device_logs の削除。
 *
 * DB・R2 は lib/runtime・lib/r2 の getDb・getMediaBucket（`cloudflare:workers` の env）から取る。
 * OPENWEATHER_API_KEY も同じ env から読む（Workers の Secret）。ログには出さない。
 */
import { env } from "cloudflare:workers";
import { and, eq, lt } from "drizzle-orm";
import type { Db } from "../db/index";
import { deviceLogs, uploads } from "../db/schema";
import { getMediaBucket, type MediaBucket } from "../lib/r2";
import { getDb } from "../lib/runtime";
import { purgeDeletedMedia } from "../lib/services/media";
import { refreshWeather } from "../lib/weather";

export const WEATHER_CRON = "*/30 * * * *";
export const DAILY_CRON = "0 19 * * *";

const UPLOAD_STALE_SECONDS = 24 * 60 * 60;
const DEVICE_LOG_RETENTION_SECONDS = 30 * 24 * 60 * 60;

export type StaleUploadsResult = { abortedIds: string[] };

/**
 * 24 時間以上 uploading のままの uploads を中断する。
 * R2 側の中断に失敗しても（すでに存在しない等）DB は aborted にする（media.ts の abortUpload と同じ扱い）。
 */
export async function abortStaleUploads(db: Db, bucket: MediaBucket, now: number): Promise<StaleUploadsResult> {
  const stale = await db
    .select()
    .from(uploads)
    .where(and(eq(uploads.state, "uploading"), lt(uploads.createdAt, now - UPLOAD_STALE_SECONDS)));

  const abortedIds: string[] = [];
  for (const row of stale) {
    try {
      await bucket.resumeMultipartUpload(row.r2Key, row.r2UploadId).abort();
    } catch (e) {
      console.warn("[scheduled] stale upload の R2 中断に失敗しました", row.id, e);
    }
    await db
      .update(uploads)
      .set({ state: "aborted" })
      .where(and(eq(uploads.id, row.id), eq(uploads.state, "uploading")));
    abortedIds.push(row.id);
  }
  return { abortedIds };
}

/** 30 日より古い device_logs を削除する */
export async function purgeOldDeviceLogs(db: Db, now: number): Promise<number> {
  const cutoff = now - DEVICE_LOG_RETENTION_SECONDS;
  const deleted = await db.delete(deviceLogs).where(lt(deviceLogs.createdAt, cutoff)).returning({ id: deviceLogs.id });
  return deleted.length;
}

async function runDailyCleanup(db: Db, bucket: MediaBucket, now: number): Promise<void> {
  const media = await purgeDeletedMedia({ db, bucket }, now);
  if (media.failed.length > 0) console.warn("[scheduled] media purge に失敗したものがあります。次回再試行します", media.failed);
  const stale = await abortStaleUploads(db, bucket, now);
  const deletedLogCount = await purgeOldDeviceLogs(db, now);
  console.log(
    `[scheduled] daily cleanup: media purged=${media.purged.length} failed=${media.failed.length} ` +
      `uploads aborted=${stale.abortedIds.length} device_logs deleted=${deletedLogCount}`,
  );
}

/** Workers の Secret。ログには出さない */
function readOpenWeatherApiKey(): string | undefined {
  return (env as unknown as { OPENWEATHER_API_KEY?: string }).OPENWEATHER_API_KEY;
}

/** wrangler.jsonc の triggers.crons に登録した式ごとに処理を分ける */
export async function scheduled(cron: string): Promise<void> {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  if (cron === WEATHER_CRON) {
    await refreshWeather(db, readOpenWeatherApiKey());
    return;
  }
  if (cron === DAILY_CRON) {
    await runDailyCleanup(db, getMediaBucket(), now);
    return;
  }
  console.warn(`[scheduled] 未登録の cron 式です: ${cron}`);
}
