/**
 * 更新系 Route Handler の Origin 検査（proxy.ts から呼ぶ）。
 *
 * vinext は Route Handler の Origin を検査しない（docs/spikes/workers.md 3 節）。
 * Server Actions は vinext 本体が別 Origin を 403 にするので、ここでは扱わない。
 * 端末用 API（/api/device/*）は Bearer トークンで認証し、ブラウザから呼ばれないので対象外。
 */

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export function needsOriginCheck(method: string, pathname: string): boolean {
  return UNSAFE_METHODS.has(method.toUpperCase()) && pathname.startsWith("/api/") && !pathname.startsWith("/api/device/");
}

/** Origin が要求先と同じなら true。Origin なし・"null" は false */
export function isSameOrigin(request: Request): boolean {
  const origin = request.headers.get("origin");
  return origin !== null && origin === new URL(request.url).origin;
}

/** 拒否するときは 403 の応答、通すときは null */
export function checkCsrf(request: Request): Response | null {
  const { pathname } = new URL(request.url);
  if (!needsOriginCheck(request.method, pathname) || isSameOrigin(request)) return null;
  return Response.json(
    { error: { code: "forbidden_origin", message: "この操作は受け付けられませんでした。画面を読み込み直してください" } },
    { status: 403 },
  );
}
