import { describe, expect, it, vi } from "vitest";
import type { Db } from "../../db/index";

vi.mock("../../lib/services/spotlights", () => ({
  listSpotlights: vi.fn(async () => [{ id: "member-a", companyName: "株式会社エー", personName: "山田 太郎" }]),
}));
const { loadCompanyResearch } = await import("../../lib/services/company-research-view");
const db = {} as Db;
const claim = (text: string) => ({ text, kind: "site_claim", sourceIds: ["page-1"], evidenceText: text });
const payload = {
  company: { name: claim("株式会社エー"), summary: claim("映像制作の会社です"), industries: [claim("映像制作")], regions: [] },
  services: [{ name: claim("縦型動画"), description: null, targetCustomers: [], problemsSolved: [], delivery: [], pricing: [] }],
  strengths: [], limitations: [], unknowns: ["料金"], sourceConflicts: [],
  sources: [{ sourceId: "page-1", url: "https://a.example/" }],
  coverage: { inputUrls: ["https://a.example/"], fetched: 3, processed: 2, skipped: [], reasons: ["unsupported_format"], status: "partial", lastFetchedAt: null },
};
const binding = (body: unknown, status = 200) => ({ fetch: vi.fn(async () => Response.json(body, { status })) });

describe("企業データの読み込み（管理画面）", () => {
  it("分析 Worker から GET で読み、掲載メンバーの名前と合わせて状態を日本語の区分にする", async () => {
    const fake = binding({ data: [
      { sourceId: "member-a", lastSuccessfulCrawlAt: 100, job: { status: "succeeded", phase: "complete", lastErrorCode: null, updatedAt: 200, urls: [{ slot: 1, url: "https://a.example/" }] }, profile: { payload, extractedAt: 150, createdAt: 160 } },
      { sourceId: "member-deleted", lastSuccessfulCrawlAt: null, job: { status: "running", phase: "crawl", lastErrorCode: null, updatedAt: 300, urls: [] }, profile: null },
    ] });
    const entries = await loadCompanyResearch(db, fake);
    expect(fake.fetch).toHaveBeenCalledWith("https://company-research.internal/internal/profiles", expect.objectContaining({ method: "GET" }));
    expect(entries).toEqual([
      expect.objectContaining({ sourceId: "member-a", member: { companyName: "株式会社エー", personName: "山田 太郎" }, status: "done", urls: ["https://a.example/"], profile: expect.objectContaining({ extractedAt: 150, unknowns: ["料金"] }) }),
      expect.objectContaining({ sourceId: "member-deleted", member: null, status: "working", profile: null }),
    ]);
  });

  it("分析 Worker に届かない・失敗・壊れた応答は null（画面で読み込めないと出す）", async () => {
    expect(await loadCompanyResearch(db, undefined)).toBeNull();
    expect(await loadCompanyResearch(db, binding({ error: {} }, 503))).toBeNull();
    expect(await loadCompanyResearch(db, binding({ data: "broken" }))).toBeNull();
    expect(await loadCompanyResearch(db, { fetch: async () => { throw new Error("network"); } })).toBeNull();
  });
});
