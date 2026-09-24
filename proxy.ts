/**
 * Next.js 16 の proxy（旧 middleware）。vinext が要求ごとに先に通す。
 *
 * - 更新系の /api/*（/api/device/* を除く）は Origin が自サイトでなければ 403（lib/csrf.ts）。
 * - /admin/* は有効な session Cookie（署名・期限）が無ければ /login へ転送する。
 *   DB の is_active・role・session_version との照合は各画面・操作の requireUser / requireRole で行う。
 */
import { env } from "cloudflare:workers";
import { getToken } from "next-auth/jwt";
import { NextResponse, type NextRequest } from "next/server";
import { checkCsrf } from "./lib/csrf";

function isAdminPath(pathname: string): boolean {
  return pathname === "/admin" || pathname.startsWith("/admin/");
}

export async function proxy(request: NextRequest): Promise<Response> {
  const csrf = checkCsrf(request);
  if (csrf) return csrf;

  if (isAdminPath(request.nextUrl.pathname)) {
    // Auth.js と同じ判断: AUTH_URL（ローカル http 開発）か要求の URL が https なら `__Secure-` 付きの Cookie 名
    const secureCookie = new URL(process.env.AUTH_URL ?? request.url).protocol === "https:";
    const token = await getToken({ req: request, secret: env.AUTH_SECRET, secureCookie });
    if (typeof token?.userId !== "string") {
      const login = new URL("/login", request.url);
      login.searchParams.set("callbackUrl", request.nextUrl.pathname + request.nextUrl.search);
      return NextResponse.redirect(login);
    }
  }

  return NextResponse.next();
}

export const config = { matcher: ["/api/:path*", "/admin", "/admin/:path*"] };
