"use server";

/**
 * ユーザー管理の Server Actions（Administrator のみ。計画 6 節の権限表）。
 * 失敗は例外にせず { ok: false, error } で返し、画面はその文言を出す。
 */
import { AuthzError, requireRole } from "../../../lib/auth";
import { getDb } from "../../../lib/runtime";
import { changeUserRole, createUser, setUserActive, UserServiceError, type UserSummary } from "../../../lib/services/users";

export type UserActionResult = { ok: true; data: UserSummary } | { ok: false; error: string };

async function run(action: () => Promise<UserSummary>): Promise<UserActionResult> {
  try {
    await requireRole("administrator");
    return { ok: true, data: await action() };
  } catch (e) {
    if (e instanceof AuthzError) {
      return { ok: false, error: e.status === 401 ? "ログインしてください" : "この操作を行う権限がありません" };
    }
    if (e instanceof UserServiceError) return { ok: false, error: e.message };
    throw e;
  }
}

export async function createUserAction(formData: FormData): Promise<UserActionResult> {
  return run(() =>
    createUser(getDb(), {
      email: formData.get("email") ?? undefined,
      name: formData.get("name") ?? undefined,
      role: formData.get("role") ?? undefined,
      password: formData.get("password") ?? undefined,
    }),
  );
}

export async function changeUserRoleAction(userId: string, role: string): Promise<UserActionResult> {
  return run(() => changeUserRole(getDb(), userId, role));
}

export async function setUserActiveAction(userId: string, active: boolean): Promise<UserActionResult> {
  return run(() => setUserActive(getDb(), userId, active === true));
}
