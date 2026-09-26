/**
 * POST /api/signage/player-log?device=<id>（ログイン不要）。
 * Web 公開のサイネージ（/signage）がテスト表示の動画を流したときの様子（再生位置・コマ数・イベントの順番・エラー）を
 * device_logs（type = web-video）に残す。端末のブラウザで動画が止まる原因を、現地に行かずに調べるため（2026-09-26）。
 *
 * - 1 件 2,000 文字まで。端末ごとに 1 日（日本時間）200 件まで。超えたら保存せず 429。
 * - 公開のページから送るので、端末が見つからないときは 404、形が違うときは 400。
 */
import { and, count, eq, gte } from "drizzle-orm";
import { z } from "zod";
import { deviceLogs, nowSeconds } from "@/db/schema";
import { startOfTokyoDay } from "@/lib/dates";
import { resolvePublicDeviceId } from "@/lib/public-signage";
import { getDb } from "@/lib/runtime";

const PLAYER_LOG_TYPE = "web-video";
const PLAYER_LOGS_PER_DAY = 200;

const bodySchema = z.object({ message: z.string().min(1).max(2000) });

export async function POST(request: Request): Promise<Response> {
  const db = getDb();
  const deviceId = await resolvePublicDeviceId(db, new URL(request.url).searchParams.get("device"));
  if (!deviceId) {
    return Response.json({ error: { code: "not_found", message: "表示できるサイネージがありません" } }, { status: 404 });
  }
  const parsed = bodySchema.safeParse(await request.json().catch(() => undefined));
  if (!parsed.success) {
    return Response.json({ error: { code: "invalid_input", message: "ログの内容が正しくありません" } }, { status: 400 });
  }
  const now = nowSeconds();
  const accepted = await db.transaction(async (tx) => {
    const [{ n }] = await tx
      .select({ n: count() })
      .from(deviceLogs)
      .where(and(eq(deviceLogs.deviceId, deviceId), eq(deviceLogs.type, PLAYER_LOG_TYPE), gte(deviceLogs.createdAt, startOfTokyoDay(now))));
    if (n >= PLAYER_LOGS_PER_DAY) return false;
    await tx.insert(deviceLogs).values({ deviceId, type: PLAYER_LOG_TYPE, message: parsed.data.message, createdAt: now });
    return true;
  });
  if (!accepted) {
    return Response.json({ error: { code: "too_many_logs", message: "本日のログの上限に達しました" } }, { status: 429 });
  }
  return new Response(null, { status: 204, headers: { "X-Robots-Tag": "noindex" } });
}
