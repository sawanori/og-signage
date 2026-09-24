/**
 * ログインの制限。
 *
 * 1. Rate Limiting binding（IP 単位とメールアドレス単位、wrangler.jsonc の LOGIN_RATE_LIMITER）。
 *    マシンごとの概算で、接続が分かれると効かないことがある（docs/spikes/workers.md 7 節）。
 * 2. DB の失敗回数。同じメールアドレスで 15 分に 10 回失敗したら、数え始めから 15 分たつまで止める。
 */
import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/index";
import { nowSeconds, users } from "../db/schema";

export type RateLimiter = { limit(options: { key: string }): Promise<{ success: boolean }> };

export const LOGIN_FAILURE_LIMIT = 10;
export const LOGIN_FAILURE_WINDOW_SECONDS = 15 * 60;

/** IP とメールアドレスのどちらかが制限を超えたら false */
export async function passesLoginRateLimit(
  limiter: RateLimiter,
  { ip, email }: { ip: string | null; email: string },
): Promise<boolean> {
  const keys = [`email:${email}`];
  if (ip) keys.push(`ip:${ip}`);
  const results = await Promise.all(keys.map((key) => limiter.limit({ key })));
  return results.every((r) => r.success);
}

type FailureState = { failedLoginCount: number; failedLoginWindowStart: number | null };

export function isLoginLocked(user: FailureState, now: number = nowSeconds()): boolean {
  return (
    user.failedLoginCount >= LOGIN_FAILURE_LIMIT &&
    user.failedLoginWindowStart !== null &&
    now - user.failedLoginWindowStart < LOGIN_FAILURE_WINDOW_SECONDS
  );
}

/** 失敗を 1 回数える。数え始めから 15 分を過ぎていれば 1 回目から数え直す（1 文で更新し、同時の失敗も取りこぼさない） */
export async function recordLoginFailure(db: Db, userId: string, now: number = nowSeconds()): Promise<void> {
  const expired = sql`(${users.failedLoginWindowStart} IS NULL OR ${users.failedLoginWindowStart} <= ${now - LOGIN_FAILURE_WINDOW_SECONDS})`;
  await db
    .update(users)
    .set({
      failedLoginCount: sql`CASE WHEN ${expired} THEN 1 ELSE ${users.failedLoginCount} + 1 END`,
      failedLoginWindowStart: sql`CASE WHEN ${expired} THEN ${now} ELSE ${users.failedLoginWindowStart} END`,
    })
    .where(eq(users.id, userId));
}

export async function resetLoginFailures(db: Db, userId: string): Promise<void> {
  await db.update(users).set({ failedLoginCount: 0, failedLoginWindowStart: null }).where(eq(users.id, userId));
}
