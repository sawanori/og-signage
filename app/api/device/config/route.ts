/**
 * GET /api/device/config（端末用。Authorization: Bearer）。計画 9 節「端末用」。
 *
 * - 本文は lib/config-builder.ts が読み取りトランザクション内で組み立て、SignageConfig の Zod 検査を通したもの。
 * - ETag は version。If-None-Match が一致すれば 304（本文なし）。
 * - 認証失敗は 401。トークンはログに出さない。
 */
import { nowSeconds } from "../../../../db/schema";
import { ConfigUnavailableError, buildDeviceConfig, matchesIfNoneMatch } from "../../../../lib/config-builder";
import { DeviceAuthError, authenticateDevice, deviceAuthErrorResponse } from "../../../../lib/device-auth";
import { getDb } from "../../../../lib/runtime";

export async function GET(request: Request): Promise<Response> {
  const db = getDb();
  try {
    const device = await authenticateDevice(db, request);
    const config = await buildDeviceConfig(db, device.id, nowSeconds());
    const headers = { etag: `"${config.version}"`, "cache-control": "private, no-cache" };
    if (matchesIfNoneMatch(request.headers.get("if-none-match"), config.version)) {
      return new Response(null, { status: 304, headers });
    }
    return Response.json(config, { headers });
  } catch (e) {
    if (e instanceof DeviceAuthError) return deviceAuthErrorResponse();
    if (e instanceof ConfigUnavailableError) {
      return Response.json(
        { error: { code: e.code, message: "表示の設定がまだそろっていません" } },
        { status: 503, headers: { "retry-after": "60" } },
      );
    }
    throw e;
  }
}
