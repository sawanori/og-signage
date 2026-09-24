/**
 * 認証（Auth.js Credentials + JWT）と権限の確認。
 *
 * - JWT に userId と sessionVersion を載せる。
 * - 保護操作ごとに DB の is_active・role・session_version と照合する（requireUser / requireRole）。
 *   無効化・版不一致は 401、役割不足は 403。役割は毎回 DB から読むので、降格は次の操作から効く。
 * - Cookie は Auth.js の既定（SameSite=Lax、HttpOnly。https では Secure 付きの `__Secure-` 名）。
 *   ローカルの http 開発では AUTH_URL=http://localhost:<port> を設定する（docs/spikes/workers.md 1 節）。
 * - 秘密鍵・DB・Rate Limiting binding は NextAuth の遅延初期化で cloudflare:workers の env から読む。
 */
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import NextAuth, { CredentialsSignin, type NextAuthConfig } from "next-auth";
import Credentials from "next-auth/providers/credentials";
import type { Db } from "../db/index";
import { users } from "../db/schema";
import { verifyPassword } from "./password";
import {
  isLoginLocked,
  passesLoginRateLimit,
  recordLoginFailure,
  resetLoginFailures,
  type RateLimiter,
} from "./rate-limit";
import { getDb } from "./runtime";

export type Role = "staff" | "administrator";
export type AuthUser = { id: string; email: string; name: string | null; role: Role };

/** 制限中のログイン。画面は「しばらくしてからお試しください」を出す */
export class LoginRateLimited extends CredentialsSignin {
  code = "rate_limited";
}

export type AuthDeps = { db: Db; limiter: RateLimiter; secret: string };

type AuthorizedUser = { id: string; email: string; name: string | null; sessionVersion: number };

export async function authorizeCredentials(
  deps: AuthDeps,
  credentials: Partial<Record<string, unknown>>,
  request: Request,
): Promise<AuthorizedUser | null> {
  const email = typeof credentials.email === "string" ? credentials.email.trim().toLowerCase() : "";
  const password = typeof credentials.password === "string" ? credentials.password : "";
  if (!email || !password) return null;

  const ip = request.headers.get("cf-connecting-ip");
  if (!(await passesLoginRateLimit(deps.limiter, { ip, email }))) throw new LoginRateLimited();

  const [user] = await deps.db.select().from(users).where(eq(users.email, email));
  if (!user) return null;
  if (isLoginLocked(user)) throw new LoginRateLimited();

  const valid = user.isActive && user.passwordHash !== null && (await verifyPassword(password, user.passwordHash));
  if (!valid) {
    await recordLoginFailure(deps.db, user.id);
    return null;
  }
  if (user.failedLoginCount > 0) await resetLoginFailures(deps.db, user.id);
  return { id: user.id, email: user.email, name: user.name, sessionVersion: user.sessionVersion };
}

export function createAuthConfig(deps: AuthDeps): NextAuthConfig {
  return {
    secret: deps.secret,
    trustHost: true,
    session: { strategy: "jwt" },
    pages: { signIn: "/login" },
    providers: [
      Credentials({
        credentials: { email: {}, password: {} },
        authorize: (credentials, request) => authorizeCredentials(deps, credentials, request),
      }),
    ],
    callbacks: {
      jwt({ token, user }) {
        if (user) {
          token.userId = user.id;
          token.sessionVersion = (user as AuthorizedUser).sessionVersion;
        }
        return token;
      },
      session({ session, token }) {
        return { ...session, userId: token.userId, sessionVersion: token.sessionVersion };
      },
    },
  };
}

export const { auth, signIn, signOut } = NextAuth(() =>
  createAuthConfig({ db: getDb(), limiter: env.LOGIN_RATE_LIMITER, secret: env.AUTH_SECRET }),
);

// ---------------------------------------------------------------- 権限の確認

export class AuthzError extends Error {
  constructor(readonly status: 401 | 403) {
    super(status === 401 ? "unauthorized" : "forbidden");
    this.name = "AuthzError";
  }
}

export type GuardDeps = { db: Db; getSession: () => Promise<unknown> };

const runtimeDeps = (): GuardDeps => ({ db: getDb(), getSession: () => auth() });

/** セッションの userId・sessionVersion を DB と照合する。無効・版不一致・該当なしは null */
export async function loadSessionUser(db: Db, session: unknown): Promise<AuthUser | null> {
  const claims = (session ?? {}) as { userId?: unknown; sessionVersion?: unknown };
  if (typeof claims.userId !== "string" || typeof claims.sessionVersion !== "number") return null;

  const [user] = await db.select().from(users).where(eq(users.id, claims.userId));
  if (!user || !user.isActive || user.sessionVersion !== claims.sessionVersion) return null;
  return { id: user.id, email: user.email, name: user.name, role: user.role };
}

/** Server Action・Route Handler 共通。拒否は AuthzError（401） */
export async function requireUser(deps: GuardDeps = runtimeDeps()): Promise<AuthUser> {
  const user = await loadSessionUser(deps.db, await deps.getSession());
  if (!user) throw new AuthzError(401);
  return user;
}

/** administrator は staff の操作もできる。拒否は AuthzError（401 / 403） */
export async function requireRole(role: Role, deps: GuardDeps = runtimeDeps()): Promise<AuthUser> {
  const user = await requireUser(deps);
  if (role === "administrator" && user.role !== "administrator") throw new AuthzError(403);
  return user;
}

export function authErrorResponse(error: AuthzError): Response {
  const body =
    error.status === 401
      ? { code: "unauthorized", message: "ログインしてください" }
      : { code: "forbidden", message: "この操作を行う権限がありません" };
  return Response.json({ error: body }, { status: error.status });
}

/** Route Handler 用。拒否は 401 / 403 の JSON を返す */
export function withRole<C>(
  role: Role,
  handler: (request: Request, context: C, user: AuthUser) => Promise<Response>,
  deps: () => GuardDeps = runtimeDeps,
) {
  return async (request: Request, context: C): Promise<Response> => {
    let user: AuthUser;
    try {
      user = await requireRole(role, deps());
    } catch (e) {
      if (e instanceof AuthzError) return authErrorResponse(e);
      throw e;
    }
    return handler(request, context, user);
  };
}
