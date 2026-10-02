/**
 * 企業データ（/admin/company-research。2026-10-02 ユーザー指示）。許可したアカウントだけが見られ、
 * それ以外のログイン中のスタッフには画面があることも知らせない（404）。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CompanyResearchEntry } from "@/lib/services/company-research-view";

const state = vi.hoisted(() => ({ email: "viewer@example.com" }));
vi.mock("next/navigation", () => ({ notFound: () => { throw new Error("NEXT_NOT_FOUND"); }, redirect: vi.fn() }));
vi.mock("@/app/admin/_components/current-user", () => ({ requirePageUser: async () => ({ id: "u", email: state.email, name: null, role: "administrator" }) }));
vi.mock("@/lib/runtime", () => ({ getDb: () => ({}) }));
const load = vi.hoisted(() => vi.fn());
vi.mock("@/lib/services/company-research-view", () => ({ loadCompanyResearch: load }));

const { default: CompanyResearchPage } = await import("@/app/admin/company-research/page");
const { CompanyResearchView } = await import("@/components/admin/company-research-view");

const claim = (text: string, kind = "site_claim") => ({ text, kind, sourceIds: ["page-1"], evidenceText: text });
const entry: CompanyResearchEntry = {
  sourceId: "member-a",
  member: { companyName: "株式会社エー", personName: "山田 太郎" },
  urls: ["https://a.example/"],
  status: "done",
  errorCode: null,
  updatedAt: 200,
  profile: {
    company: { name: claim("株式会社エー"), summary: claim("企業向けの映像制作をしています"), industries: [claim("映像制作", "fact")], regions: [] },
    services: [{ name: claim("縦型動画制作"), description: claim("SNS 向けの短い動画"), targetCustomers: [claim("中小企業")], problemsSolved: [], delivery: [], pricing: [] }],
    strengths: [], limitations: [], unknowns: ["料金は掲載されていません"], sourceConflicts: [],
    sources: [{ sourceId: "page-1", url: "https://a.example/" }],
    coverage: { inputUrls: ["https://a.example/"], fetched: 3, processed: 2, skipped: [], reasons: ["unsupported_format"], status: "partial", lastFetchedAt: null },
    extractedAt: 1_790_000_000,
  },
};

afterEach(() => { state.email = "viewer@example.com"; load.mockReset(); });

describe("企業データの画面", () => {
  it("許可したアカウント以外は 404 にし、企業データを読みに行かない", async () => {
    state.email = "staff@example.com";
    await expect(CompanyResearchPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(load).not.toHaveBeenCalled();
  });

  it("許可したアカウントには、会社ごとの概要・サービス・根拠のリンク・取得の状況を出す", async () => {
    load.mockResolvedValue([entry, { ...entry, sourceId: "member-b", member: { companyName: "合同会社ビー", personName: "佐藤" }, status: "failed", errorCode: "no_eligible_pages", profile: null }]);
    const html = renderToStaticMarkup(await CompanyResearchPage());
    expect(html).toContain("企業データ");
    expect(html).toContain("株式会社エー");
    expect(html).toContain("山田 太郎 さん");
    expect(html).toContain("企業向けの映像制作をしています");
    expect(html).toContain("縦型動画制作");
    expect(html).toContain("中小企業");
    expect(html).toContain("事実");
    expect(html).toMatch(/href="https:\/\/a\.example\/" target="_blank" rel="noreferrer noopener"/);
    expect(html).toContain("取得 3 ページのうち 2 ページを AI に送りました（一部）");
    expect(html).toContain("PDF など読めない資料がありました");
    expect(html).toContain("料金は掲載されていません");
    expect(html).toContain("取得したページから、AI に送れる企業情報が見つかりませんでした");
  });

  it("読み込めないとき・まだ誰もいないときはその旨を出す", () => {
    expect(renderToStaticMarkup(<CompanyResearchView entries={null} />)).toContain("企業データを読み込めませんでした");
    expect(renderToStaticMarkup(<CompanyResearchView entries={[]} />)).toContain("ホームページの URL を登録したメンバーはまだいません");
  });
});
