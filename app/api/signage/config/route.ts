/**
 * GET /api/signage/config?device=<id>（ログイン不要）。
 * Web 公開のサイネージ（/signage）が 30 秒ごとに取り直す。中身は lib/public-signage.ts。
 * 応答にこの版の印（BUILD_HEADER）を付け、表示中のページが新しい版に気づいて読み直せるようにする（reload-on-new-build.ts）。
 */
import { nowSeconds } from "@/db/schema";
import { BUILD_HEADER, BUILD_ID } from "@/lib/build-id";
import { ConfigUnavailableError } from "@/lib/config-builder";
import { buildPublicSignageConfig, resolvePublicDeviceId } from "@/lib/public-signage";
import { getDb } from "@/lib/runtime";

export async function GET(request: Request): Promise<Response> {
  const db = getDb();
  const deviceId = await resolvePublicDeviceId(db, new URL(request.url).searchParams.get("device"));
  if (!deviceId) {
    return Response.json({ error: { code: "not_found", message: "表示できるサイネージがありません" } }, { status: 404 });
  }
  try {
    const config = await buildPublicSignageConfig(db, deviceId, nowSeconds(), new URL(request.url).origin);
    return Response.json(config, {
      headers: { "Cache-Control": "no-store", "X-Robots-Tag": "noindex", ...(BUILD_ID ? { [BUILD_HEADER]: BUILD_ID } : {}) },
    });
  } catch (e) {
    if (e instanceof ConfigUnavailableError) {
      return Response.json({ error: { code: "unavailable", message: "表示の準備ができていません" } }, { status: 503 });
    }
    throw e;
  }
}
