/**
 * 画面用のログイン確認。無効化・セッションの版ずれなどで照合に失敗したらログイン画面へ送る。
 */
import { redirect } from "next/navigation";
import { AuthzError, requireUser, type AuthUser } from "@/lib/auth";

export async function requirePageUser(): Promise<AuthUser> {
  try {
    return await requireUser();
  } catch (e) {
    if (e instanceof AuthzError) redirect("/login");
    throw e;
  }
}
