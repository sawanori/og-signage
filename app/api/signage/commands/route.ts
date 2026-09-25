/**
 * GET /api/signage/commands?device=<id>（ログイン不要）。
 * Web 公開のサイネージ（/signage）が数秒ごとに確かめる、テスト表示の要求だけの軽い応答。
 * config 全体（30 秒ごと）を待たずに、管理画面で押したらすぐ動画を流すため（2026-09-25 ユーザー指示）。
 */
import { eq } from "drizzle-orm";
import { devices } from "@/db/schema";
import { resolvePublicDeviceId } from "@/lib/public-signage";
import { getDb } from "@/lib/runtime";

export async function GET(request: Request): Promise<Response> {
  const db = getDb();
  const deviceId = await resolvePublicDeviceId(db, new URL(request.url).searchParams.get("device"));
  const [row] = deviceId
    ? await db
        .select({ testPlayRequestedAt: devices.testPlayRequestedAt, testPlayMediaId: devices.testPlayMediaId })
        .from(devices)
        .where(eq(devices.id, deviceId))
    : [];
  if (!row) {
    return Response.json({ error: { code: "not_found", message: "表示できるサイネージがありません" } }, { status: 404 });
  }
  return Response.json(row, { headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex" } });
}
