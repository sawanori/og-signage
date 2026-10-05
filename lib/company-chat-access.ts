/**
 * メンバー相談チャットを使えるかどうか（2026-10-05 ユーザー指示「まずはスタッフやあなたのアカウントだけで試す」）。
 * 許可するメールアドレスは wrangler.jsonc の COMPANY_CHAT_EMAILS（カンマ区切り）。未設定なら誰も使えない。
 */
import { canViewCompanyResearch } from "./company-research-viewer";

export const COMPANY_CHAT_PATH = "/chat";

export function canUseCompanyChat(email: string, allowList: string | undefined): boolean {
  return canViewCompanyResearch(email, allowList);
}
