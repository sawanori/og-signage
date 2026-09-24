/**
 * POST /api/device/media-failures（端末用）。取得・再生に失敗した画像・動画・表示バンドルを記録する。計画 9 節
 *
 * - (端末, mediaId または bundleId, reason) ごとに 1 行。報告 1 件ごとに count を 1 足し、last_at と quarantined は最新の報告で置き換える。
 * - もう存在しない media・バンドルへの報告は保存しない（外部キーがあるため）。応答の ignored に件数を返す。
 */
import { inArray, sql } from "drizzle-orm";
import { displayBundles, media, mediaFailures } from "../../../../db/schema";
import { DeviceAuthError, authenticateDevice, deviceAuthErrorResponse } from "../../../../lib/device-auth";
import { getDb } from "../../../../lib/runtime";
import { mediaFailuresSchema } from "../../../../lib/validators";

export async function POST(request: Request): Promise<Response> {
  const db = getDb();
  try {
    const device = await authenticateDevice(db, request);
    const parsed = mediaFailuresSchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) {
      return Response.json({ error: { code: "invalid_input", message: "失敗報告の内容が正しくありません" } }, { status: 400 });
    }
    const failures = parsed.data.failures;
    const mediaIds = failures.flatMap((f) => (f.mediaId ? [f.mediaId] : []));
    const bundleIds = failures.flatMap((f) => (f.bundleId ? [f.bundleId] : []));

    const accepted = await db.transaction(async (tx) => {
      const knownMedia = new Set(
        mediaIds.length ? (await tx.select({ id: media.id }).from(media).where(inArray(media.id, mediaIds))).map((r) => r.id) : [],
      );
      const knownBundles = new Set(
        bundleIds.length
          ? (await tx.select({ id: displayBundles.id }).from(displayBundles).where(inArray(displayBundles.id, bundleIds))).map((r) => r.id)
          : [],
      );
      let n = 0;
      for (const f of failures) {
        const known = f.mediaId ? knownMedia.has(f.mediaId) : knownBundles.has(f.bundleId!);
        if (!known) continue;
        await tx
          .insert(mediaFailures)
          .values({
            deviceId: device.id,
            mediaId: f.mediaId,
            bundleId: f.bundleId,
            reason: f.reason,
            quarantined: f.quarantined,
            count: 1,
            lastAt: f.occurredAt,
          })
          .onConflictDoUpdate({
            target: f.mediaId
              ? [mediaFailures.deviceId, mediaFailures.mediaId, mediaFailures.reason]
              : [mediaFailures.deviceId, mediaFailures.bundleId, mediaFailures.reason],
            set: {
              count: sql`${mediaFailures.count} + 1`,
              lastAt: sql`excluded.last_at`,
              quarantined: sql`excluded.quarantined`,
            },
          });
        n++;
      }
      return n;
    });
    return Response.json({ accepted, ignored: failures.length - accepted });
  } catch (e) {
    if (e instanceof DeviceAuthError) return deviceAuthErrorResponse();
    throw e;
  }
}
