/** POST /api/device/heartbeat（端末用）。最新値を devices に保存し last_seen_at を進める。計画 9 節 */
import { nowSeconds } from "../../../../db/schema";
import { DeviceAuthError, authenticateDevice, deviceAuthErrorResponse } from "../../../../lib/device-auth";
import { getDb } from "../../../../lib/runtime";
import { recordHeartbeat } from "../../../../lib/services/devices";
import { heartbeatSchema } from "../../../../lib/validators";

export async function POST(request: Request): Promise<Response> {
  const db = getDb();
  try {
    const device = await authenticateDevice(db, request);
    const parsed = heartbeatSchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) {
      return Response.json({ error: { code: "invalid_input", message: "Heartbeat の内容が正しくありません" } }, { status: 400 });
    }
    await recordHeartbeat(db, device.id, parsed.data, nowSeconds());
    return new Response(null, { status: 204 });
  } catch (e) {
    if (e instanceof DeviceAuthError) return deviceAuthErrorResponse();
    throw e;
  }
}
