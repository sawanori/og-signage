/**
 * POST /api/device/logs（端末用）。1 回 50 件まで、端末ごとに 1 日（日本時間）5,000 件まで。計画 9 節
 *
 * - 上限を超える送信は 1 件も保存せず 429（Pi は 429 のとき同じまとまりを後で送り直すので、一部だけ保存すると重複する）。
 * - created_at はサーバーの受信時刻。上限の数え方と 30 日での削除（task_013）をサーバーの時計で揃えるため
 *   （Pi は時刻未同期のことがある。計画 6 節の前提 13）。
 * - 数える処理と保存は同じ書き込みトランザクションで行い、同時送信で上限を超えないようにする。
 */
import { and, count, eq, gte } from "drizzle-orm";
import { deviceLogs, nowSeconds } from "../../../../db/schema";
import { startOfTokyoDay } from "../../../../lib/dates";
import { DeviceAuthError, authenticateDevice, deviceAuthErrorResponse } from "../../../../lib/device-auth";
import { getDb } from "../../../../lib/runtime";
import { deviceLogsSchema } from "../../../../lib/validators";

const DEVICE_LOGS_PER_DAY = 5000;

export async function POST(request: Request): Promise<Response> {
  const db = getDb();
  try {
    const device = await authenticateDevice(db, request);
    const parsed = deviceLogsSchema.safeParse(await request.json().catch(() => undefined));
    if (!parsed.success) {
      return Response.json({ error: { code: "invalid_input", message: "ログの内容が正しくありません" } }, { status: 400 });
    }
    const now = nowSeconds();
    const accepted = await db.transaction(async (tx) => {
      const [{ n }] = await tx
        .select({ n: count() })
        .from(deviceLogs)
        .where(and(eq(deviceLogs.deviceId, device.id), gte(deviceLogs.createdAt, startOfTokyoDay(now))));
      if (n + parsed.data.logs.length > DEVICE_LOGS_PER_DAY) return false;
      await tx
        .insert(deviceLogs)
        .values(parsed.data.logs.map((log) => ({ deviceId: device.id, type: log.type, message: log.message, createdAt: now })));
      return true;
    });
    if (!accepted) {
      return Response.json(
        { error: { code: "too_many_logs", message: "本日のログの上限に達しました" } },
        { status: 429, headers: { "retry-after": String(startOfTokyoDay(now) + 24 * 60 * 60 - now) } },
      );
    }
    return new Response(null, { status: 204 });
  } catch (e) {
    if (e instanceof DeviceAuthError) return deviceAuthErrorResponse();
    throw e;
  }
}
