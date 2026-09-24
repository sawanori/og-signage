/**
 * 端末用 API の認証（計画 6 節の前提 5、9 節）。
 *
 * - `Authorization: Bearer <token>` からトークンを取り出し、SHA-256 を devices.token_hash と照合する。
 * - 照合は定数時間比較。失敗はすべて DeviceAuthError（401）で、理由を区別しない。
 * - トークンの平文はログ・例外メッセージに含めない。
 */
import { eq } from "drizzle-orm";
import type { Db } from "../db/index";
import { devices } from "../db/schema";

export type Device = typeof devices.$inferSelect;

/** 32 バイト乱数の base64url（パディングなし）は 43 文字 */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export class DeviceAuthError extends Error {
  readonly status = 401;
  constructor() {
    super("unauthorized");
    this.name = "DeviceAuthError";
  }
}

/** トークンの SHA-256（小文字16進64桁）。Workers と Node の両方の Web Crypto で動く */
export async function hashDeviceToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** 長さが同じ文字列を、内容によらず同じ手数で比べる */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** `Bearer <token>` からトークンを取り出す。形式が違えば null */
export function parseBearerToken(authorization: string | null): string | null {
  const match = /^Bearer ([^\s]+)$/i.exec(authorization?.trim() ?? "");
  if (!match || !TOKEN_PATTERN.test(match[1])) return null;
  return match[1];
}

/** 要求の端末を返す。認証できなければ DeviceAuthError（401） */
export async function authenticateDevice(db: Db, request: Request): Promise<Device> {
  const token = parseBearerToken(request.headers.get("authorization"));
  if (!token) throw new DeviceAuthError();

  const hash = await hashDeviceToken(token);
  const [device] = await db.select().from(devices).where(eq(devices.tokenHash, hash));
  if (!device || !constantTimeEqual(device.tokenHash, hash)) throw new DeviceAuthError();
  return device;
}

export function deviceAuthErrorResponse(): Response {
  return Response.json({ error: { code: "unauthorized", message: "端末の認証に失敗しました" } }, { status: 401 });
}
