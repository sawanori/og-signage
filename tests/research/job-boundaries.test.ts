import { afterEach, describe, expect, it, vi } from "vitest";
import { buildCompanyResearchEvent } from "../../lib/company-research-contract";
import { researchJobs, researchPages, researchProfiles, researchSubjects, researchUsage } from "../../research/db/schema";
import type { ResearchEnv } from "../../research/env";
import { acceptResearchEvent } from "../../research/intake";
import { runResearchTick, type ResearchProviders } from "../../research/jobs";
import { RESEARCH_MODEL, RESEARCH_PROMPT_VERSION } from "../../research/profile-schema";
import { openTestResearchDatabase } from "./db-helper";

const connections: Awaited<ReturnType<typeof openTestResearchDatabase>>[] = [];
afterEach(() => { for (const connection of connections.splice(0)) connection.close(); });

function record(path: string, markdown: string) {
  return { url: `https://example.com/${path}`, status: "completed", markdown, metadata: { status: 200 } };
}

async function setup() {
  const connection = await openTestResearchDatabase();
  connections.push(connection);
  const objects = new Map<string, string>();
  const env: ResearchEnv = {
    RESEARCH_PAID_ENABLED: "true", MODEL_API_KEY: "fake", CRAWL_API_TOKEN: "fake", CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
    RESEARCH_BUCKET: {
      put: vi.fn(async (key, value) => { objects.set(key, String(value)); }),
      get: vi.fn(async (key) => objects.has(key) ? { text: async () => objects.get(key)! } : null),
      delete: vi.fn(async (keys) => { for (const key of typeof keys === "string" ? [keys] : keys) objects.delete(key); }),
    },
  };
  await acceptResearchEvent(connection.db, await buildCompanyResearchEvent({
    sourceId: "member", sourceRevision: 0, eventType: "upsert", urls: [{ slot: 1, url: "https://example.com/" }],
  }), 100);
  const api: ResearchProviders = {
    startCrawl: vi.fn(async (args) => {
      await args.beforePaidCall({ provider: "crawl", inputTokens: 0, outputTokens: 0, costMicroUsd: 30_000, browserSeconds: 1200 });
      return { id: "crawl-boundary" };
    }),
    pollCrawl: vi.fn<ResearchProviders["pollCrawl"]>(),
    cancelCrawl: vi.fn(async () => {}),
    extractProfile: vi.fn<ResearchProviders["extractProfile"]>(async (args) => {
      await args.beforePaidCall({ provider: "meta", inputTokens: 1000, outputTokens: 1000, costMicroUsd: 300, browserSeconds: 0 });
      return {
        profile: {
          schemaVersion: 1, sourceId: args.sourceId, generation: args.generation, model: RESEARCH_MODEL,
          promptVersion: RESEARCH_PROMPT_VERSION, extractedAt: args.now!.toISOString(),
          company: { name: null, summary: null, industries: [], regions: [] }, services: [], strengths: [], limitations: [], unknowns: ["料金不明"], sourceConflicts: [],
        },
        usage: { inputTokens: 100, outputTokens: 100, cachedInputTokens: 0, reasoningTokens: 0, costMicroUsd: 30 }, inputTokenEstimate: 1000,
      };
    }),
  };
  const tick = (now: number) => runResearchTick(connection.db, env, { now, providers: api });
  return { ...connection, env, api, tick };
}

describe("research worker interruption boundaries", () => {
  it("resumes the persisted terminal cursor on a new DB connection without starting or charging the crawl again", async () => {
    const x = await setup();
    const first = record("services/", "法人向けのウェブ制作サービスを提供しています。企画から公開まで対応します。");
    const last = record("support/", "公開後のウェブサイト保守サービスを提供しています。更新と運用まで対応します。");
    vi.mocked(x.api.pollCrawl)
      .mockResolvedValueOnce({ id: "crawl-boundary", status: "completed", browserSecondsUsed: 2, total: 2, finished: 2, cursor: "page-2", records: [first] })
      .mockResolvedValueOnce({ id: "crawl-boundary", status: "completed", browserSecondsUsed: 2, total: 2, finished: 2, cursor: null, records: [first, last] });

    await x.tick(100);
    await x.tick(160);
    const [checkpoint] = await x.db.select().from(researchJobs);
    expect(checkpoint).toMatchObject({ status: "queued", phase: "crawl", leaseToken: null, nextRunAt: 220 });
    expect(checkpoint.progress).toMatchObject({ crawls: [{ id: "crawl-boundary", cursor: "page-2", done: false }] });
    expect(await x.db.select().from(researchPages)).toHaveLength(1);
    expect(x.api.extractProfile).not.toHaveBeenCalled();

    const restarted = x.openAnother();
    x.client.close();
    try {
      for (const now of [220, 280, 340]) await runResearchTick(restarted.db, x.env, { now, providers: x.api });
      expect(vi.mocked(x.api.pollCrawl).mock.calls.map(([args]) => ({ id: args.id, cursor: args.cursor }))).toEqual([
        { id: "crawl-boundary", cursor: null }, { id: "crawl-boundary", cursor: "page-2" },
      ]);
      expect(x.api.startCrawl).toHaveBeenCalledTimes(1);
      expect(x.api.extractProfile).toHaveBeenCalledTimes(1);
      expect(await restarted.db.select().from(researchPages)).toHaveLength(2);
      const [profile] = await restarted.db.select().from(researchProfiles);
      expect(profile.payload.coverage).toMatchObject({ status: "complete", fetched: 2, processed: 2, reasons: [], skipped: [] });
      const usage = await restarted.db.select().from(researchUsage);
      expect(usage.filter((row) => row.provider === "crawl")).toEqual([expect.objectContaining({ status: "settled", chargedMicrousd: 50, providerFinishedAt: 220 })]);
      expect((await restarted.db.select().from(researchJobs))[0]).toMatchObject({ status: "succeeded", phase: "complete" });
    } finally { restarted.close(); }
  });

  it("cancels at 20 minutes, retains completed pages and unknown costs, and stores a partial profile", async () => {
    const x = await setup();
    const finished = record("services/", "法人向けのウェブ制作サービスを提供しています。企画から公開まで対応します。");
    vi.mocked(x.api.pollCrawl).mockResolvedValue({
      id: "crawl-boundary", status: "running", browserSecondsUsed: 1199, total: 2, finished: 1, cursor: "pending-records",
      records: [finished, { url: "https://example.com/unfinished/", status: "queued", metadata: undefined }],
    });
    await x.tick(100);
    await x.tick(1240);
    expect(x.api.cancelCrawl).not.toHaveBeenCalled();
    expect((await x.db.select().from(researchJobs))[0].progress).toMatchObject({ crawls: [{ done: false, cursor: null }] });

    await x.tick(1300);
    expect(x.api.cancelCrawl).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "crawl-boundary" }));
    expect((await x.db.select().from(researchJobs))[0].progress).toMatchObject({
      crawls: [{ done: true, cancelled: true, status: "timed_out" }], reasons: ["crawl_time_limit"],
    });
    expect((await x.db.select().from(researchUsage))[0]).toMatchObject({ status: "unknown", chargedMicrousd: 30_000, providerFinishedAt: 1300 });
    expect(x.api.extractProfile).not.toHaveBeenCalled();

    for (const now of [1360, 1420, 1480]) await x.tick(now);
    expect(x.api.pollCrawl).toHaveBeenCalledTimes(2);
    expect(x.api.startCrawl).toHaveBeenCalledTimes(1);
    expect(x.api.cancelCrawl).toHaveBeenCalledTimes(1);
    expect(x.api.extractProfile).toHaveBeenCalledTimes(1);
    expect(vi.mocked(x.api.extractProfile).mock.calls[0][0].pages).toEqual([expect.objectContaining({ markdown: finished.markdown })]);
    const [profile] = await x.db.select().from(researchProfiles);
    expect(profile.payload.coverage).toMatchObject({ status: "partial", fetched: 1, processed: 1, reasons: ["crawl_time_limit"] });
    expect((await x.db.select().from(researchJobs))[0]).toMatchObject({ status: "succeeded", progress: { crawlSuccessful: false } });
    expect((await x.db.select().from(researchSubjects))[0].lastSuccessfulCrawlAt).toBeNull();
  });
});
