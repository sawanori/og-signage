"use server";

/**
 * メンバー紹介（サイネージの MEMBER SPOTLIGHT）の Server Actions（Staff 以上）。
 *
 * お知らせ（content.ts）と同じ包み方にそろえる。
 * - `requireRole` でログイン中のユーザーを DB 照合込みで取得してからサービスを呼ぶ。
 * - ServiceError（入力不正・見つからない・revision 競合）と AuthzError（未ログイン・権限不足）を、
 *   利用者向けの日本語を持つ `{ error }` に変換して返す。それ以外の例外はそのまま投げる（想定外の不具合として扱う）。
 */
import { AuthzError, requireRole, type AuthUser } from "../../../lib/auth";
import { getDb } from "../../../lib/runtime";
import { ServiceError } from "../../../lib/services/notices";
import * as spotlights from "../../../lib/services/spotlights";
import type { ActionResult } from "./content";

async function run<T>(fn: (user: AuthUser) => Promise<T>): Promise<ActionResult<T>> {
  try {
    const user = await requireRole("staff");
    return { data: await fn(user) };
  } catch (e) {
    if (e instanceof ServiceError) return { error: { code: e.code, message: e.message } };
    if (e instanceof AuthzError) {
      return {
        error:
          e.status === 401
            ? { code: "unauthorized", message: "ログインしてください" }
            : { code: "forbidden", message: "この操作を行う権限がありません" },
      };
    }
    throw e;
  }
}

export async function createSpotlightAction(input: unknown): Promise<ActionResult<spotlights.SpotlightRow>> {
  return run((user) => spotlights.createSpotlight(getDb(), user, input));
}

export async function updateSpotlightAction(id: string, input: unknown): Promise<ActionResult<spotlights.SpotlightRow>> {
  return run((user) => spotlights.updateSpotlight(getDb(), user, id, input));
}

export async function deleteSpotlightAction(id: string): Promise<ActionResult<null>> {
  return run(async (user) => {
    await spotlights.deleteSpotlight(getDb(), user, id);
    return null;
  });
}
