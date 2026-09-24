import { encode } from "next-auth/jwt";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { checkCsrf, needsOriginCheck } from "../../lib/csrf";
import { proxy } from "../../proxy";
import { env } from "../stubs/cloudflare-workers";

const ORIGIN = "https://signage.example";

function request(method: string, path: string, origin?: string, cookie?: string) {
  const headers = new Headers();
  if (origin !== undefined) headers.set("origin", origin);
  if (cookie) headers.set("cookie", cookie);
  return new NextRequest(`${ORIGIN}${path}`, { method, headers });
}

describe("checkCsrf", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE"])("%s /api/* は自サイトの Origin だけ通す", async (method) => {
    expect(checkCsrf(request(method, "/api/events", ORIGIN))).toBeNull();

    for (const origin of ["https://evil.example", "null", "http://signage.example", undefined]) {
      const res = checkCsrf(request(method, "/api/events", origin));
      expect(res?.status).toBe(403);
    }
  });

  it("エラー本文は利用者向けの日本語", async () => {
    const res = checkCsrf(request("POST", "/api/events", "https://evil.example"))!;
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("forbidden_origin");
    expect(body.error.message).not.toMatch(/origin|csrf/i);
  });

  it("GET・HEAD は対象外", () => {
    expect(checkCsrf(request("GET", "/api/events", "https://evil.example"))).toBeNull();
    expect(checkCsrf(request("HEAD", "/api/events"))).toBeNull();
  });

  it("/api/device/* は対象外（Bearer トークンで認証する）", () => {
    expect(checkCsrf(request("POST", "/api/device/heartbeat"))).toBeNull();
    expect(checkCsrf(request("POST", "/api/device/logs", "https://evil.example"))).toBeNull();
    expect(needsOriginCheck("POST", "/api/devices")).toBe(true);
  });

  it("/api/ 以外は対象外", () => {
    expect(needsOriginCheck("POST", "/login")).toBe(false);
  });
});

describe("proxy", () => {
  it("別 Origin・Origin なしの更新系 /api/* は 403", async () => {
    expect((await proxy(request("POST", "/api/media/uploads", "https://evil.example"))).status).toBe(403);
    expect((await proxy(request("DELETE", "/api/events/e1"))).status).toBe(403);
    expect((await proxy(request("POST", "/api/media/uploads", ORIGIN))).headers.get("x-middleware-next")).toBe("1");
    expect((await proxy(request("POST", "/api/device/heartbeat"))).headers.get("x-middleware-next")).toBe("1");
  });

  it("未ログインの /admin/* は /login へ転送（戻り先つき）", async () => {
    for (const path of ["/admin", "/admin/events?view=calendar"]) {
      const res = await proxy(request("GET", path));
      expect(res.status).toBe(307);
      const location = new URL(res.headers.get("location")!);
      expect(location.origin + location.pathname).toBe(`${ORIGIN}/login`);
      expect(location.searchParams.get("callbackUrl")).toBe(path);
    }
  });

  it("有効な session Cookie があれば /admin/* を通す。改ざん・別の鍵は転送", async () => {
    const name = "__Secure-authjs.session-token";
    const token = await encode({ token: { userId: "u1", sessionVersion: 0 }, secret: env.AUTH_SECRET, salt: name });
    const ok = await proxy(request("GET", "/admin/events", undefined, `${name}=${token}`));
    expect(ok.headers.get("x-middleware-next")).toBe("1");

    const forged = await encode({ token: { userId: "u1", sessionVersion: 0 }, secret: "another-secret-another-secret-01", salt: name });
    expect((await proxy(request("GET", "/admin", undefined, `${name}=${forged}`))).status).toBe(307);
    expect((await proxy(request("GET", "/admin", undefined, `${name}=${token.slice(0, -4)}AAAA`))).status).toBe(307);
  });
});
