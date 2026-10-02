/**
 * 企業データ（/admin/company-research。2026-10-02 ユーザー指示）。
 * 許可したアカウント（COMPANY_RESEARCH_VIEWER_EMAILS）以外には、画面があることも知らせず 404 にする。
 * 検索に出さない指示（X-Robots-Tag: noindex）は worker/index.ts がすべての応答に付ける。
 */
import { env } from "cloudflare:workers";
import { notFound } from "next/navigation";
import { CompanyResearchView } from "@/components/admin/company-research-view";
import { ADMIN_TITLE } from "@/components/admin/brand";
import { canViewCompanyResearch } from "@/lib/company-research-viewer";
import { getDb } from "@/lib/runtime";
import { loadCompanyResearch } from "@/lib/services/company-research-view";
import { requirePageUser } from "../_components/current-user";

export const dynamic = "force-dynamic";

export const metadata = { title: `企業データ | ${ADMIN_TITLE}`, robots: { index: false, follow: false } };

export default async function CompanyResearchPage() {
  const user = await requirePageUser();
  if (!canViewCompanyResearch(user.email, env.COMPANY_RESEARCH_VIEWER_EMAILS)) notFound();
  const entries = await loadCompanyResearch(getDb(), env.COMPANY_RESEARCH);
  return <CompanyResearchView entries={entries} />;
}
