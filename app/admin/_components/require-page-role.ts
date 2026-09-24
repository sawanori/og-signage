/**
 * Administrator 専用画面のログイン・権限確認。
 * 未ログインはログイン画面へ送る（requirePageUser と同じ扱い）。権限不足（Staff がここを開いた場合）は
 * null を返すので、呼び出し元の画面が「この画面は管理者のみ利用できます」を表示する。
 */
import { redirect } from "next/navigation";
import { AuthzError, requireRole, type AuthUser, type Role } from "@/lib/auth";

export async function requirePageRole(role: Role): Promise<AuthUser | null> {
  try {
    return await requireRole(role);
  } catch (e) {
    if (e instanceof AuthzError) {
      if (e.status === 401) redirect("/login");
      return null;
    }
    throw e;
  }
}
