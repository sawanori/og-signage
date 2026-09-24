/**
 * Administrator 専用画面の入口（計画 6 節の権限表）。未ログイン・無効化はログイン画面へ、Staff はダッシュボードへ送る。
 */
import { redirect } from "next/navigation";
import { AuthzError, requireRole, type AuthUser } from "@/lib/auth";

export async function requireAdminPage(): Promise<AuthUser> {
  try {
    return await requireRole("administrator");
  } catch (e) {
    if (e instanceof AuthzError) redirect(e.status === 401 ? "/login" : "/admin");
    throw e;
  }
}
