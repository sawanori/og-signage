/**
 * Auth.js（@auth/core の Auth）に実際の要求を通してログインし、発行された JWT で権限の確認を試す。
 * DB は一時 libSQL ファイル。Rate Limiting binding は偽物を渡す。
 */
import { Auth, skipCSRFCheck, type AuthConfig } from "@auth/core";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../../db/index";
import { users } from "../../db/schema";
import {
  AuthzError,
  createAuthConfig,
  requireRole,
  requireUser,
  withRole,
  type AuthDeps,
  type GuardDeps,
  type Role,
} from "../../lib/auth";
import { hashPassword } from "../../lib/password";
import { LOGIN_FAILURE_LIMIT, LOGIN_FAILURE_WINDOW_SECONDS, type RateLimiter } from "../../lib/rate-limit";
import { openTempDb } from "../helpers/temp-db";

const ORIGIN = "https://signage.example";
const PASSWORD = "correct horse battery";
const SECRET = "test-secret-test-secret-test-secret-0123";

let db: Db;
let close: () => void;
let limiterKeys: string[];
let limiterAllows: boolean;

const limiter: RateLimiter = {
  async limit({ key }) {
    limiterKeys.push(key);
    return { success: limiterAllows };
  },
};

function config(): AuthConfig {
  const deps: AuthDeps = { db, limiter, secret: SECRET };
  return { ...createAuthConfig(deps), basePath: "/api/auth", skipCSRFCheck };
}

async function addUser(email: string, role: Role) {
  // 保存形式に回数が入るので、テストは反復を減らして速くする
  const [row] = await db
    .insert(users)
    .values({ email, name: email, role, passwordHash: await hashPassword(PASSWORD, 1000) })
    .returning({ id: users.id });
  return row.id;
}

type LoginResult = { location: string; cookie: string | null; setCookie: string | null };

async function login(email: string, password: string): Promise<LoginResult> {
  const res = await Auth(
    new Request(`${ORIGIN}/api/auth/callback/credentials`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.7" },
      body: new URLSearchParams({ email, password, callbackUrl: "/admin" }),
    }),
    config(),
  );
  const setCookie = res.headers.getSetCookie().find((c) => c.startsWith("__Secure-authjs.session-token=")) ?? null;
  return { location: res.headers.get("location") ?? "", cookie: setCookie?.split(";")[0] ?? null, setCookie };
}

/** Auth.js が Cookie から読み出したセッション（auth() が返すものと同じ） */
async function readSession(cookie: string | null): Promise<unknown> {
  const res = await Auth(new Request(`${ORIGIN}/api/auth/session`, { headers: { cookie: cookie ?? "" } }), config());
  return res.json();
}

function guard(cookie: string | null): GuardDeps {
  return { db, getSession: () => readSession(cookie) };
}

async function loginOk(email: string): Promise<string> {
  const result = await login(email, PASSWORD);
  expect(result.cookie).not.toBeNull();
  return result.cookie!;
}

async function expectAuthz(promise: Promise<unknown>, status: 401 | 403) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(AuthzError);
  expect((error as AuthzError).status).toBe(status);
}

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  limiterKeys = [];
  limiterAllows = true;
});

afterEach(() => close());

describe("ログイン", () => {
  it("正しいパスワードで JWT の Cookie が出る（SameSite=Lax; Secure; HttpOnly）", async () => {
    const id = await addUser("staff@example.com", "staff");
    const result = await login("Staff@Example.com ", PASSWORD);

    expect(result.location).toBe(`${ORIGIN}/admin`);
    expect(result.setCookie).toMatch(/; HttpOnly/i);
    expect(result.setCookie).toMatch(/; Secure/i);
    expect(result.setCookie).toMatch(/; SameSite=Lax/i);

    const session = (await readSession(result.cookie)) as { userId: string; sessionVersion: number };
    expect(session.userId).toBe(id);
    expect(session.sessionVersion).toBe(0);
    expect(limiterKeys.sort()).toEqual(["email:staff@example.com", "ip:203.0.113.7"]);
  });

  it("パスワード誤り・存在しないメール・無効なユーザーは同じ失敗（Cookie なし）", async () => {
    const id = await addUser("staff@example.com", "staff");
    await addUser("off@example.com", "staff");
    await db.update(users).set({ isActive: false }).where(eq(users.email, "off@example.com"));

    for (const [email, password] of [
      ["staff@example.com", "wrong password!!"],
      ["nobody@example.com", PASSWORD],
      ["off@example.com", PASSWORD],
    ]) {
      const result = await login(email, password);
      expect(result.cookie).toBeNull();
      expect(result.location).toBe(`${ORIGIN}/login?error=CredentialsSignin&code=credentials`);
    }
    const [row] = await db.select().from(users).where(eq(users.id, id));
    expect(row.failedLoginCount).toBe(1);
  });
});

describe("ログインの制限", () => {
  it(`同じメールで ${LOGIN_FAILURE_LIMIT} 回失敗すると、正しいパスワードでも 15 分止まる`, async () => {
    const id = await addUser("staff@example.com", "staff");
    for (let i = 0; i < LOGIN_FAILURE_LIMIT; i++) {
      expect((await login("staff@example.com", "wrong password!!")).location).toContain("code=credentials");
    }

    const locked = await login("staff@example.com", PASSWORD);
    expect(locked.cookie).toBeNull();
    expect(locked.location).toBe(`${ORIGIN}/login?error=CredentialsSignin&code=rate_limited`);

    // 数え始めから 15 分たったら解除され、成功で回数が 0 に戻る
    const now = Math.floor(Date.now() / 1000);
    await db
      .update(users)
      .set({ failedLoginWindowStart: now - LOGIN_FAILURE_WINDOW_SECONDS })
      .where(eq(users.id, id));
    expect((await login("staff@example.com", PASSWORD)).cookie).not.toBeNull();
    const [row] = await db.select().from(users).where(eq(users.id, id));
    expect(row.failedLoginCount).toBe(0);
    expect(row.failedLoginWindowStart).toBeNull();
  });

  it("15 分以内の失敗が上限に届かなければ止めない", async () => {
    await addUser("staff@example.com", "staff");
    for (let i = 0; i < LOGIN_FAILURE_LIMIT - 1; i++) await login("staff@example.com", "wrong password!!");
    expect((await login("staff@example.com", PASSWORD)).cookie).not.toBeNull();
  });

  it("Rate Limiting binding が拒否したら、パスワードを照合せずに止める", async () => {
    await addUser("staff@example.com", "staff");
    limiterAllows = false;
    const result = await login("staff@example.com", PASSWORD);
    expect(result.cookie).toBeNull();
    expect(result.location).toContain("code=rate_limited");
  });
});

describe("権限（requireUser / requireRole / withRole）", () => {
  it("未ログインは 401", async () => {
    await expectAuthz(requireUser(guard(null)), 401);
    const res = await withRole("staff", async () => new Response("ok"), () => guard(null))(new Request(ORIGIN), {});
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: "unauthorized", message: "ログインしてください" } });
  });

  it("Staff は Staff の操作はできるが、Administrator 専用の操作は 403", async () => {
    const id = await addUser("staff@example.com", "staff");
    const cookie = await loginOk("staff@example.com");

    expect((await requireRole("staff", guard(cookie))).id).toBe(id);
    await expectAuthz(requireRole("administrator", guard(cookie)), 403);

    const route = withRole("administrator", async () => new Response("ok"), () => guard(cookie));
    const res = await route(new Request(ORIGIN), {});
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: { code: "forbidden", message: "この操作を行う権限がありません" } });
  });

  it("Administrator は Administrator 専用の操作ができる", async () => {
    const id = await addUser("admin@example.com", "administrator");
    const cookie = await loginOk("admin@example.com");
    const res = await withRole("administrator", async (_req, _ctx: unknown, user) => Response.json({ id: user.id }), () =>
      guard(cookie),
    )(new Request(ORIGIN), {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id });
  });

  it("無効化すると旧 JWT は 401", async () => {
    const id = await addUser("admin@example.com", "administrator");
    const cookie = await loginOk("admin@example.com");
    await db.update(users).set({ isActive: false }).where(eq(users.id, id));

    await expectAuthz(requireUser(guard(cookie)), 401);
    const res = await withRole("staff", async () => new Response("ok"), () => guard(cookie))(new Request(ORIGIN), {});
    expect(res.status).toBe(401);
  });

  it("降格すると旧 JWT では Administrator 専用の操作が 403（役割は毎回 DB から読む）", async () => {
    const id = await addUser("admin@example.com", "administrator");
    const cookie = await loginOk("admin@example.com");
    await requireRole("administrator", guard(cookie));

    await db.update(users).set({ role: "staff" }).where(eq(users.id, id));
    await expectAuthz(requireRole("administrator", guard(cookie)), 403);
  });

  it("session_version を上げると旧 JWT は 401、再ログインで使える", async () => {
    const id = await addUser("admin@example.com", "administrator");
    const cookie = await loginOk("admin@example.com");
    await db.update(users).set({ sessionVersion: 1 }).where(eq(users.id, id));

    await expectAuthz(requireRole("staff", guard(cookie)), 401);

    const fresh = await loginOk("admin@example.com");
    expect((await requireRole("administrator", guard(fresh))).id).toBe(id);
  });

  it("改ざんした Cookie は 401", async () => {
    await addUser("admin@example.com", "administrator");
    const cookie = await loginOk("admin@example.com");
    await expectAuthz(requireUser(guard(`${cookie.slice(0, -4)}AAAA`)), 401);
  });
});
