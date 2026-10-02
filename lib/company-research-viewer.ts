/**
 * 管理画面の「企業データ」を見られるかどうか（2026-10-02 ユーザー指示「snp.inc.info のアカウントだけ」）。
 * 許可するメールアドレスは wrangler.jsonc の COMPANY_RESEARCH_VIEWER_EMAILS（カンマ区切り）。未設定なら誰も見られない。
 */
export function canViewCompanyResearch(email: string, allowList: string | undefined): boolean {
  const target = email.trim().toLowerCase();
  if (!target || !allowList) return false;
  return allowList.split(",").some((entry) => entry.trim().toLowerCase() === target);
}
