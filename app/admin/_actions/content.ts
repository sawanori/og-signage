"use server";

/**
 * お知らせ・デザイン設定・ハウスルール・カテゴリ・表示スケジュールの Server Actions。
 *
 * - `requireRole` でログイン中のユーザーを DB 照合込みで取得してからサービスを呼ぶ。
 * - サービス層（lib/services/*）が投げる ServiceError（入力不正・見つからない・revision 競合）と
 *   AuthzError（未ログイン・権限不足）を、利用者向けの日本語を持つ `{ error }` に変換して返す。
 *   それ以外の例外はそのまま投げる（想定外の不具合として扱う）。
 */
import { AuthzError, requireRole, type AuthUser, type Role } from "../../../lib/auth";
import { getDb } from "../../../lib/runtime";
import * as house from "../../../lib/services/house";
import * as notices from "../../../lib/services/notices";
import { ServiceError } from "../../../lib/services/notices";
import * as schedule from "../../../lib/services/schedule";

export type ActionResult<T> = { data: T; error?: undefined } | { data?: undefined; error: { code: string; message: string } };

async function run<T>(role: Role, fn: (user: AuthUser) => Promise<T>): Promise<ActionResult<T>> {
  try {
    const user = await requireRole(role);
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

// ---------------------------------------------------------------- お知らせ（Staff 以上）

export async function createNoticeAction(input: unknown): Promise<ActionResult<notices.NoticeRow>> {
  return run("staff", (user) => notices.createNotice(getDb(), user, input));
}

export async function updateNoticeAction(id: string, input: unknown): Promise<ActionResult<notices.NoticeRow>> {
  return run("staff", (user) => notices.updateNotice(getDb(), user, id, input));
}

export async function deleteNoticeAction(id: string): Promise<ActionResult<null>> {
  return run("staff", async (user) => {
    await notices.deleteNotice(getDb(), user, id);
    return null;
  });
}

// ---------------------------------------------------------- デザイン設定・ハウスルール・カテゴリ（Administrator）

export async function updateDesignSettingsAction(input: unknown): Promise<ActionResult<house.HouseSettingsRow>> {
  return run("administrator", (user) => house.updateDesignSettings(getDb(), user, input));
}

export async function updateHouseRulesAction(input: unknown): Promise<ActionResult<house.HouseRuleRow[]>> {
  return run("administrator", (user) => house.replaceHouseRules(getDb(), user, input));
}

export async function updateEventCategoriesAction(input: unknown): Promise<ActionResult<house.EventCategoryRow[]>> {
  return run("administrator", (user) => house.updateEventCategories(getDb(), user, input));
}

// ---------------------------------------------------------------- 表示スケジュール（Administrator）

export async function updateDisplayScheduleAction(input: unknown): Promise<ActionResult<schedule.DisplayScheduleRow[]>> {
  return run("administrator", (user) => schedule.replaceDisplaySchedule(getDb(), user, input));
}
