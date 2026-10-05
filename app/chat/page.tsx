/**
 * メンバー相談チャット（/chat。2026-10-05 ユーザー指示。試験運用）。
 * サイネージの管理画面とは別の画面。ログインは管理画面と同じものを使い、COMPANY_CHAT_EMAILS に入っている
 * アカウント以外には、画面があることも知らせず 404 にする。検索に出さない指示は worker/index.ts がすべての応答に付ける。
 */
import { env } from "cloudflare:workers";
import { notFound, redirect } from "next/navigation";
import { CompanyChat } from "@/components/chat/company-chat";
import { AuthzError, requireUser, type AuthUser } from "@/lib/auth";
import { canUseCompanyChat, COMPANY_CHAT_PATH } from "@/lib/company-chat-access";

export const dynamic = "force-dynamic";

export const metadata = { title: "メンバー相談チャット", robots: { index: false, follow: false } };
export const viewport = { width: "device-width", initialScale: 1 };

export default async function CompanyChatPage() {
  let user: AuthUser;
  try {
    user = await requireUser();
  } catch (e) {
    // ログインしたら、この画面へ戻す
    if (e instanceof AuthzError) redirect(`/login?callbackUrl=${encodeURIComponent(COMPANY_CHAT_PATH)}`);
    throw e;
  }
  if (!canUseCompanyChat(user.email, env.COMPANY_CHAT_EMAILS)) notFound();
  return <CompanyChat />;
}
