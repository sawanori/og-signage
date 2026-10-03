import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { buildCompanyResearchEvent } from "../../lib/company-research-contract";
import { acceptResearchEvent } from "../../research/intake";
import { claimResearchJob, checkpointResearchJob, finishResearchJob, runResearchTick, cancelInactiveResearchCrawls, LEASE_SECONDS, type ResearchProviders } from "../../research/jobs";
import { researchJobs, researchPages, researchProfiles, researchSubjects, researchUsage } from "../../research/db/schema";
import { ProviderError, startCrawl } from "../../research/crawler";
import { DnsLookupError, UrlPolicyError } from "../../research/url-policy";
import { RESEARCH_MODEL, RESEARCH_PROMPT_VERSION } from "../../research/profile-schema";
import type { ResearchEnv } from "../../research/env";
import { openTestResearchDatabase } from "./db-helper";
import providerProbe from "../../docs/reviews/company-research-provider-probe.json";

const all: Awaited<ReturnType<typeof openTestResearchDatabase>>[] = [];
afterEach(() => { for (const connection of all.splice(0)) connection.close(); });
async function setup() {
  const connection = await openTestResearchDatabase(); all.push(connection);
  const objects = new Map<string, string>();
  const env: ResearchEnv = { RESEARCH_PAID_ENABLED: "true", MODEL_API_KEY: "fake", CRAWL_API_TOKEN: "fake", CLOUDFLARE_ACCOUNT_ID: "a".repeat(32), RESEARCH_BUCKET: { put: vi.fn(async (key, value) => { objects.set(key, String(value)); }), get: vi.fn(async (key) => objects.has(key) ? { text: async () => objects.get(key)! } : null), delete: vi.fn(async (keys) => { for (const key of typeof keys === "string" ? [keys] : keys) objects.delete(key); }) } };
  const input = await buildCompanyResearchEvent({ sourceId: "member", sourceRevision: 0, eventType: "upsert", urls: [{ slot: 1, url: "https://example.com/" }] });
  await acceptResearchEvent(connection.db, input, 100);
  const api: ResearchProviders = {
    startCrawl: vi.fn(async (args) => { await args.beforePaidCall({ provider: "crawl", inputTokens: 0, outputTokens: 0, costMicroUsd: 30_000, browserSeconds: 1200 }); return { id: "crawl-id" }; }),
    pollCrawl: vi.fn(async () => ({ id: "crawl-id", status: "completed", browserSecondsUsed: 2, total: 1, finished: 1, cursor: null, records: [{ url: "https://example.com/", status: "completed", markdown: "法人向けのウェブ制作サービスを提供しています。制作から公開まで対応します。", metadata: { status: 200 } }] })),
    cancelCrawl: vi.fn(async () => {}),
    extractProfile: vi.fn<ResearchProviders["extractProfile"]>(async (args) => { await args.beforePaidCall({ provider: "meta", inputTokens: 1000, outputTokens: 1000, costMicroUsd: 300, browserSeconds: 0 }); return { profile: { schemaVersion: 1, sourceId: args.sourceId, generation: args.generation, model: RESEARCH_MODEL, promptVersion: RESEARCH_PROMPT_VERSION, extractedAt: args.now!.toISOString(), company: { name: null, summary: null, industries: [], regions: [] }, services: [], strengths: [], limitations: [], unknowns: ["料金不明"], sourceConflicts: [] }, usage: { inputTokens: 100, outputTokens: 100, cachedInputTokens: 0, reasoningTokens: 0, costMicroUsd: 30 }, inputTokenEstimate: 1000 }; }),
  };
  const tick = (now: number) => runResearchTick(connection.db, env, { now, providers: api });
  return { ...connection, env, objects, api, tick, input };
}

describe("durable research execution", () => {
  it("is paid-off by default and canary only claims allowed sources", async () => {
    const x = await setup(); x.env.RESEARCH_PAID_ENABLED = "false";
    await x.tick(100); expect(x.api.startCrawl).not.toHaveBeenCalled();
    x.env.RESEARCH_CANARY_SOURCE_IDS = "other";
    await x.tick(100); expect(x.api.startCrawl).not.toHaveBeenCalled();
    x.env.RESEARCH_CANARY_SOURCE_IDS = "member";
    await x.tick(100); expect(x.api.startCrawl).toHaveBeenCalledTimes(1);
  });

  it("claims at most one job, recovers an expired lease and refuses an old token", async () => {
    const x = await setup(); const second = x.openAnother();
    try {
      const first = await claimResearchJob(x.db, x.env, 100);
      expect(first).not.toBeNull();
      expect(await claimResearchJob(second.db, x.env, 101)).toBeNull();
      expect(await claimResearchJob(second.db, x.env, 99 + LEASE_SECONDS)).toBeNull();
      const recovered = await claimResearchJob(second.db, x.env, 101 + LEASE_SECONDS);
      expect(recovered?.leaseToken).not.toBe(first?.leaseToken);
      expect(recovered?.attempts).toBe(1);
      await expect(checkpointResearchJob(x.db, first!, { progress: {} }, 102 + LEASE_SECONDS)).rejects.toMatchObject({ code: "stale_job" });
    } finally { second.close(); }
  });

  it("persists phases and evidence, then refreshes unchanged content without changing AI extraction time", async () => {
    const x = await setup();
    for (const time of [100, 160, 220, 280]) await x.tick(time);
    const [profile] = await x.db.select().from(researchProfiles);
    expect(profile.payload).toHaveProperty("coverage.status", "complete");
    expect(profile.payload).toHaveProperty("sources.0.markdownKey");
    expect(x.api.extractProfile).toHaveBeenCalledTimes(1);
    const base = 220 + 30 * 86_400;
    const refresh = { ...x.input, eventId: crypto.randomUUID(), sourceRevision: 1 };
    await acceptResearchEvent(x.db, refresh, base);
    for (const time of [base, base + 60, base + 120, base + 180]) await x.tick(time);
    expect(x.api.extractProfile).toHaveBeenCalledTimes(1);
    const profiles = await x.db.select().from(researchProfiles);
    expect(profiles).toHaveLength(2);
    expect(profiles[1].extractedAt).toBe(profile.extractedAt);
    expect((await x.db.select().from(researchSubjects))[0].lastSuccessfulCrawlAt).toBe(base + 120);
    await acceptResearchEvent(x.db, { ...refresh, eventId: crypto.randomUUID(), sourceRevision: 2 }, base + 86_400);
    await x.tick(base + 86_400);
    expect(x.api.startCrawl).toHaveBeenCalledTimes(2);
    expect(await x.db.select().from(researchJobs)).toHaveLength(2);
  });

  it("rejects old-job completion after URL replacement and keeps the current profile unset", async () => {
    const x = await setup(); const claimed = await claimResearchJob(x.db, x.env, 100);
    await acceptResearchEvent(x.db, await buildCompanyResearchEvent({ sourceId: "member", sourceRevision: 1, eventType: "upsert", urls: [{ slot: 1, url: "https://another.example.com/" }] }), 101);
    await expect(finishResearchJob(x.db, claimed!, {}, "hash", { crawls: [], reasons: [], skipped: [] }, 102)).rejects.toMatchObject({ code: "stale_job" });
    expect((await x.db.select().from(researchSubjects))[0].currentProfileId).toBeNull();
  });

  it("deletes while paused, cancels the tracked crawl and cannot call Meta", async () => {
    const x = await setup(); await x.tick(100);
    await acceptResearchEvent(x.db, await buildCompanyResearchEvent({ sourceId: "member", sourceRevision: 1, eventType: "delete", urls: [] }), 101);
    x.env.RESEARCH_PAID_ENABLED = "false";
    await cancelInactiveResearchCrawls(x.db, x.env, { now: 102, providers: x.api });
    await x.tick(160);
    expect(x.api.cancelCrawl).toHaveBeenCalledTimes(1);
    expect(x.api.extractProfile).not.toHaveBeenCalled();
    expect((await x.db.select().from(researchUsage))[0].status).toBe("unknown");
  });

  it("keeps pages when a registered bare-domain URL redirects to the www host (production maxtart-inc.com case)", async () => {
    const x = await setup();
    await acceptResearchEvent(x.db, await buildCompanyResearchEvent({ sourceId: "member", sourceRevision: 1, eventType: "upsert", urls: [{ slot: 1, url: "http://maxtart.example/" }] }), 100);
    x.api.pollCrawl = vi.fn(async () => ({ id: "crawl-id", status: "completed", browserSecondsUsed: 2, total: 2, finished: 2, cursor: null, records: [
      { url: "http://maxtart.example/", status: "completed", markdown: "美容室向けのヘアケア商品を企画・販売しています。全国のサロンに卸しています。", metadata: { url: "https://www.maxtart.example/", status: 200 } },
      { url: "https://www.instagram.example/maxtart", status: "completed", markdown: "外部の SNS のページです。会社の情報ではありません。", metadata: { url: "https://www.instagram.example/maxtart", status: 200 } },
    ] }));
    for (const time of [100, 160, 220, 280]) await x.tick(time);
    const pages = await x.db.select().from(researchPages);
    expect(pages.map((page) => [page.canonicalUrl, page.status])).toEqual([["https://www.maxtart.example/", "ready"]]);
    expect(x.api.extractProfile).toHaveBeenCalledTimes(1);
    const [profile] = await x.db.select().from(researchProfiles);
    expect(profile.payload).toHaveProperty("coverage.processed", 1);
  });

  it("never accepts external final URLs or a blocked record as model input", async () => {
    const x = await setup();
    x.api.pollCrawl = vi.fn(async () => ({ id: "crawl-id", status: "completed", browserSecondsUsed: 1, total: 2, finished: 2, cursor: null, records: [{ url: "https://example.com/", status: "completed", markdown: "危険な内容ではなくとも別ドメインへ移動した本文を採用しません。", metadata: { url: "https://evil.example.org/", status: 200 } }, { url: "https://example.com/blocked", status: "disallowed", metadata: undefined, markdown: "企業サービスの詳細情報です。許可がない場合には送信しません。" }] }));
    for (const time of [100, 160, 220, 280]) await x.tick(time);
    expect(x.api.extractProfile).not.toHaveBeenCalled();
    expect(await x.db.select().from(researchPages)).toHaveLength(0);
    expect((await x.db.select().from(researchJobs))[0].lastErrorCode).toBe("no_eligible_pages");
  });

  it("keeps URL-specific coverage for two sites with more than 100 pages, PII, robots, failures and linked PDFs", async () => {
    const x = await setup();
    await acceptResearchEvent(x.db, await buildCompanyResearchEvent({ sourceId: "member", sourceRevision: 1, eventType: "upsert", urls: [{ slot: 1, url: "https://example.com/" }, { slot: 2, url: "https://second.example.com/" }] }), 100);
    x.api.startCrawl = vi.fn(async (args) => {
      await args.beforePaidCall({ provider: "crawl", inputTokens: 0, outputTokens: 0, costMicroUsd: 30_000, browserSeconds: 1200 });
      return { id: new URL(args.url).hostname };
    });
    const page = (host: string, index: number) => ({ url: `https://${host}/services/${index}`, status: "completed", markdown: `法人向けのウェブ制作サービスを提供しています。公開と運用まで対応するプラン番号${index}、対象事業${host}。`, metadata: { status: 200 } });
    x.api.pollCrawl = vi.fn(async (args) => {
      const records = args.id === "example.com" ? [
        { ...page("example.com", 0), html: '<a href="/brochure.pdf">企業向けサービス資料</a>' },
        ...Array.from({ length: 48 }, (_, index) => page("example.com", index + 1)),
        { url: "https://example.com/team/", status: "completed", markdown: "山田 太郎の経歴とプロフィールです。代表者の情報を掲載しています。", metadata: { status: 200 } },
        { url: "https://example.com/robots-blocked", status: "disallowed", metadata: undefined },
        { url: "https://example.com/unavailable", status: "errored", metadata: undefined },
      ] : Array.from({ length: 51 }, (_, index) => page("second.example.com", index));
      return { id: args.id, status: "completed", browserSecondsUsed: 2, total: records.length, finished: records.length, cursor: null, records };
    });
    for (const time of [100, 160, 220, 280, 340, 400]) await x.tick(time);
    const rows = await x.db.select().from(researchPages);
    expect(rows).toHaveLength(100);
    expect(rows.filter((row) => row.status === "ready")).toHaveLength(99);
    expect(x.api.extractProfile).toHaveBeenCalledTimes(1);
    const modelPages = vi.mocked(x.api.extractProfile).mock.calls[0][0].pages;
    expect(modelPages).toHaveLength(99);
    expect(modelPages.map((item) => item.markdown).join("\n")).not.toMatch(/山田|太郎|プロフィール/u);
    const [profile] = await x.db.select().from(researchProfiles);
    expect(profile.payload).toHaveProperty("coverage.status", "partial");
    expect(profile.payload).toHaveProperty("coverage.fetched", 100);
    expect(profile.payload).toHaveProperty("coverage.processed", 99);
    expect(profile.payload.coverage).toEqual(expect.objectContaining({ skipped: expect.arrayContaining([
      { url: "https://example.com/brochure.pdf", reason: "unsupported_format" },
      { url: "https://example.com/team/", reason: "personal_page" },
      { url: "https://example.com/robots-blocked", reason: "crawl_record_disallowed" },
      { url: "https://example.com/unavailable", reason: "crawl_record_errored" },
      { url: "https://second.example.com/services/50", reason: "page_limit" },
    ]) }));
    expect(rows.some((row) => row.canonicalUrl.endsWith(".pdf"))).toBe(false);
  });

  it("revisits running crawl records and only advances pagination after completion", async () => {
    const x = await setup();
    const record = (name: string) => ({ url: `https://example.com/${name}`, status: "completed", markdown: `法人向けウェブ制作の${name}サービスを提供しています。制作から公開まで対応します。`, metadata: { status: 200 } });
    x.api.pollCrawl = vi.fn<ResearchProviders["pollCrawl"]>()
      .mockResolvedValueOnce({ id: "crawl-id", status: "running", browserSecondsUsed: 1, total: 3, finished: 1, cursor: "pending-cursor", records: [{ url: "https://example.com/later", status: "queued", metadata: undefined }, record("early")] })
      .mockResolvedValueOnce({ id: "crawl-id", status: "completed", browserSecondsUsed: 2, total: 3, finished: 3, cursor: "terminal-next", records: [record("later"), record("early")] })
      .mockResolvedValueOnce({ id: "crawl-id", status: "completed", browserSecondsUsed: 2, total: 3, finished: 3, cursor: null, records: [record("last")] });
    for (const time of [100, 160, 220, 280, 340, 400]) await x.tick(time);
    expect(vi.mocked(x.api.pollCrawl).mock.calls.map(([args]) => args.cursor)).toEqual([null, null, "terminal-next"]);
    expect(await x.db.select().from(researchPages)).toHaveLength(3);
    const [profile] = await x.db.select().from(researchProfiles);
    expect(profile.payload.coverage).toEqual(expect.objectContaining({ status: "complete", reasons: [], skipped: [], processed: 3 }));
  });

  it("retains unknown reservations and stops after three temporary failures", async () => {
    const x = await setup();
    x.api.startCrawl = vi.fn(async (args) => { await args.beforePaidCall({ provider: "crawl", inputTokens: 0, outputTokens: 0, costMicroUsd: 30_000, browserSeconds: 1200 }); throw new ProviderError("provider_network_unknown", true); });
    await x.tick(100); await x.tick(160); await x.tick(280); await x.tick(1000);
    expect(x.api.startCrawl).toHaveBeenCalledTimes(3);
    expect((await x.db.select().from(researchJobs))[0].status).toBe("failed");
    const usage = await x.db.select().from(researchUsage);
    expect(usage).toHaveLength(3);
    expect(usage.every((row) => row.status === "unknown" && row.chargedMicrousd === 30_000)).toBe(true);
  });

  it("records configuration failures without retrying paid calls", async () => {
    const x = await setup();
    await acceptResearchEvent(x.db, await buildCompanyResearchEvent({ sourceId: "member", sourceRevision: 1, eventType: "upsert", urls: [{ slot: 1, url: "https://example.com/" }, { slot: 2, url: "https://second.example.com/" }] }), 100);
    x.api.startCrawl = vi.fn(async () => { throw new ProviderError("provider_configuration_error", false, 401); });
    await x.tick(100); await x.tick(160);
    expect(x.api.startCrawl).toHaveBeenCalledTimes(1);
    expect((await x.db.select().from(researchJobs)).find((job) => job.generation === 2)?.status).toBe("configuration_required");
    expect(await x.db.select().from(researchUsage)).toHaveLength(0);
  });

  it.each([1, 2])("continues the other URL after URL %i is refused by Content-Signal and retains the unknown reservation", async (blockedSlot) => {
    const x = await setup();
    const urls = [{ slot: 1 as const, url: "https://example.com/" }, { slot: 2 as const, url: "https://second.example.com/" }];
    const blockedUrl = urls[blockedSlot - 1].url;
    const allowedUrl = urls[2 - blockedSlot].url;
    await acceptResearchEvent(x.db, await buildCompanyResearchEvent({ sourceId: "member", sourceRevision: 1, eventType: "upsert", urls }), 100);
    const captured = providerProbe.crawl.find((item) => item.case === "content_signal_block")!;
    x.api.startCrawl = vi.fn(async (args) => startCrawl({ ...args, resolveHostname: async () => ["1.1.1.1"], fetcher: async () =>
      args.url === blockedUrl ? new Response(JSON.stringify(captured.start), { status: captured.startStatus }) : new Response(JSON.stringify({ success: true, result: "allowed-crawl" })),
    }));
    x.api.pollCrawl = vi.fn(async () => ({ id: "allowed-crawl", status: "completed", browserSecondsUsed: 2, total: 1, finished: 1, cursor: null,
      records: [{ url: allowedUrl, status: "completed", markdown: "法人向けウェブ制作サービスを提供しています。制作から公開と保守まで対応します。", metadata: { status: 200 } }],
    }));
    for (const time of [100, 160, 220, 280, 340, 400]) await x.tick(time);
    expect(vi.mocked(x.api.startCrawl).mock.calls.map(([args]) => args.url)).toEqual(urls.map((item) => item.url));
    expect(x.api.pollCrawl).toHaveBeenCalledTimes(1);
    expect(x.api.extractProfile).toHaveBeenCalledTimes(1);
    const [subject] = await x.db.select().from(researchSubjects);
    const [job] = await x.db.select().from(researchJobs).where(eq(researchJobs.jobId, subject.currentJobId!));
    expect(job).toMatchObject({ status: "succeeded", phase: "complete", progress: { nextUrlIndex: 2, crawlSuccessful: true } });
    const [profile] = await x.db.select().from(researchProfiles);
    expect(profile.payload.coverage).toEqual(expect.objectContaining({ status: "partial", inputUrls: urls.map((item) => item.url), skipped: [{ url: blockedUrl, reason: "crawl_site_disallowed" }], processed: 1 }));
    expect(profile.payload.sources).toEqual([expect.objectContaining({ url: allowedUrl })]);
    const usage = await x.db.select().from(researchUsage);
    expect(usage).toHaveLength(3);
    expect(usage.find((row) => row.operationKey === `initial:crawl:${blockedSlot - 1}:0`)).toMatchObject({ status: "unknown", chargedMicrousd: 30_000, providerRequestId: null });
    expect(usage.reduce((total, row) => total + row.chargedMicrousd, 0)).toBe(30_080);
    expect(x.api.cancelCrawl).not.toHaveBeenCalled();
  });

  it.each([1, 2])("continues the other URL after URL %i fails the public-URL check, and reuses the result on the next save", async (badSlot) => {
    const x = await setup();
    const urls = [{ slot: 1 as const, url: "https://example.com/" }, { slot: 2 as const, url: "https://second.example.com/" }];
    const badUrl = urls[badSlot - 1].url;
    const goodUrl = urls[2 - badSlot].url;
    const event = await buildCompanyResearchEvent({ sourceId: "member", sourceRevision: 1, eventType: "upsert", urls });
    await acceptResearchEvent(x.db, event, 100);
    // Same path as a typo domain: DNS answers NXDOMAIN before any reservation is made.
    x.api.startCrawl = vi.fn(async (args) => startCrawl({ ...args, resolveHostname: async (host) => host === new URL(badUrl).hostname ? Promise.reject(new UrlPolicyError()) : ["1.1.1.1"],
      fetcher: async () => new Response(JSON.stringify({ success: true, result: "allowed-crawl" })) }));
    x.api.pollCrawl = vi.fn(async () => ({ id: "allowed-crawl", status: "completed", browserSecondsUsed: 2, total: 1, finished: 1, cursor: null,
      records: [{ url: goodUrl, status: "completed", markdown: "法人向けウェブ制作サービスを提供しています。制作から公開と保守まで対応します。", metadata: { status: 200 } }],
    }));
    for (const time of [100, 160, 220, 280, 340, 400]) await x.tick(time);
    expect(x.api.pollCrawl).toHaveBeenCalledTimes(1);
    expect(x.api.extractProfile).toHaveBeenCalledTimes(1);
    const [subject] = await x.db.select().from(researchSubjects);
    const [job] = await x.db.select().from(researchJobs).where(eq(researchJobs.jobId, subject.currentJobId!));
    expect(job).toMatchObject({ status: "succeeded", lastErrorCode: null, progress: { crawlSuccessful: true } });
    const [profile] = await x.db.select().from(researchProfiles);
    expect(profile.payload.coverage).toEqual(expect.objectContaining({ status: "partial", skipped: [{ url: badUrl, reason: "unsafe_url" }], processed: 1 }));
    const usage = await x.db.select().from(researchUsage);
    expect(usage.filter((row) => row.provider === "crawl")).toHaveLength(1);
    // Editing the member again with unchanged URLs must not pay for another crawl.
    await acceptResearchEvent(x.db, { ...event, eventId: crypto.randomUUID(), sourceRevision: 2 }, 500);
    for (const time of [500, 560, 620]) await x.tick(time);
    expect(await x.db.select().from(researchJobs)).toHaveLength(2);
    expect(await x.db.select().from(researchUsage)).toHaveLength(usage.length);
  });

  it("retries a temporary DNS failure instead of skipping the URL", async () => {
    const x = await setup();
    x.api.startCrawl = vi.fn(async (args) => startCrawl({ ...args, resolveHostname: async () => { throw new DnsLookupError(); } }));
    await x.tick(100);
    expect((await x.db.select().from(researchJobs))[0]).toMatchObject({ status: "retry", phase: "crawl", progress: {} });
    expect(await x.db.select().from(researchUsage)).toHaveLength(0);
  });

  it("stops a job at its own AI allowance instead of parking it until next month", async () => {
    const x = await setup();
    x.api.extractProfile = vi.fn<ResearchProviders["extractProfile"]>(async (args) => { await args.beforePaidCall({ provider: "meta", inputTokens: 500_001, outputTokens: 1000, costMicroUsd: 300, browserSeconds: 0 }); throw new Error("unreachable"); });
    for (const time of [100, 160, 220, 280, 400, 1000]) await x.tick(time);
    expect(x.api.extractProfile).toHaveBeenCalledTimes(1);
    expect((await x.db.select().from(researchJobs))[0]).toMatchObject({ status: "failed", lastErrorCode: "job_budget_exhausted" });
    expect((await x.db.select().from(researchUsage)).filter((row) => row.provider === "meta")).toHaveLength(0);
  });

  it("keeps a missing browser usage value unknown instead of releasing its reservation", async () => {
    const x = await setup();
    x.api.pollCrawl = vi.fn(async () => ({ id: "crawl-id", status: "completed", browserSecondsUsed: null, total: 0, finished: 0, cursor: null, records: [] }));
    await x.tick(100); await x.tick(160);
    expect((await x.db.select().from(researchUsage))[0]).toMatchObject({ status: "unknown", chargedMicrousd: 30_000, providerFinishedAt: 160 });
  });

  it("treats the observed cancelled_by_user provider status as terminal", async () => {
    const x = await setup();
    x.api.pollCrawl = vi.fn(async () => ({ id: "crawl-id", status: "cancelled_by_user", browserSecondsUsed: 0, total: 1, finished: 0, cursor: null, records: [{ url: "https://example.com/", status: "cancelled", metadata: undefined }] }));
    await x.tick(100); await x.tick(160); await x.tick(220);
    expect(x.api.cancelCrawl).not.toHaveBeenCalled();
    expect((await x.db.select().from(researchUsage))[0]).toMatchObject({ status: "settled", chargedMicrousd: 0, providerFinishedAt: 160 });
    expect((await x.db.select().from(researchJobs))[0]).toMatchObject({ phase: "extract", progress: { crawlSuccessful: false, reasons: ["crawl_record_cancelled", "crawl_cancelled_by_user"], skipped: [{ url: "https://example.com/", reason: "crawl_record_cancelled" }] } });
  });

  it("rechecks actual time after provider validation before making a paid request", async () => {
    const x = await setup(); let now = 100; let requests = 0;
    x.api.startCrawl = vi.fn(async (args) => { now = 101 + LEASE_SECONDS; await args.beforePaidCall({ provider: "crawl", inputTokens: 0, outputTokens: 0, costMicroUsd: 30_000, browserSeconds: 1200 }); requests++; return { id: "expired" }; });
    await runResearchTick(x.db, x.env, { clock: () => now, providers: x.api });
    expect(requests).toBe(0);
    expect(await x.db.select().from(researchUsage)).toHaveLength(0);
  });

  it("tracks and cancels a returned crawl ID when deletion wins while creation is in flight", async () => {
    const x = await setup();
    x.api.startCrawl = vi.fn(async (args) => {
      await args.beforePaidCall({ provider: "crawl", inputTokens: 0, outputTokens: 0, costMicroUsd: 30_000, browserSeconds: 1200 });
      await acceptResearchEvent(x.db, await buildCompanyResearchEvent({ sourceId: "member", sourceRevision: 1, eventType: "delete", urls: [] }), 101);
      return { id: "late-created" };
    });
    await x.tick(100);
    const [usage] = await x.db.select().from(researchUsage);
    expect(usage).toMatchObject({ providerRequestId: "late-created", status: "unknown", chargedMicrousd: 30_000 });
    expect((await x.db.select().from(researchJobs))[0].progress).toEqual({});
    await cancelInactiveResearchCrawls(x.db, x.env, { now: 102, providers: x.api });
    expect(x.api.cancelCrawl).toHaveBeenCalledWith(expect.objectContaining({ id: "late-created" }));
    expect((await x.db.select().from(researchUsage))[0].providerFinishedAt).toBe(102);
  });

  it("moves a crawl whose cancellation fails behind the others", async () => {
    const x = await setup();
    const others = Array.from({ length: 26 }, (_, i) => ({ sourceId: `gone-${i}`, sourceRevision: 0, urlFingerprint: "fingerprint", status: "deleted" as const, currentJobId: null }));
    await x.db.insert(researchSubjects).values(others);
    await x.db.insert(researchJobs).values(others.map((row, i) => ({ jobId: `job-${i}`, sourceId: row.sourceId, generation: 1, urlFingerprint: "fingerprint", urls: [], status: "superseded" as const, updatedAt: 0, progress: {} })));
    await x.db.insert(researchUsage).values(others.map((_, i) => ({ reservationId: `usage-${i}`, jobId: `job-${i}`, operationKey: "initial", provider: "crawl" as const, providerRequestId: `stuck-${i}`, month: "1970-01", status: "started" as const, reservedMicrousd: 30_000, chargedMicrousd: 30_000, priceVersion: "test", updatedAt: i })));
    x.api.cancelCrawl = vi.fn(async (args) => { if (args.id.startsWith("stuck-") && Number(args.id.slice(6)) < 25) throw new ProviderError("provider_http_404", false, 404); });
    await cancelInactiveResearchCrawls(x.db, x.env, { now: 100, providers: x.api });
    await cancelInactiveResearchCrawls(x.db, x.env, { now: 101, providers: x.api });
    expect(x.api.cancelCrawl).toHaveBeenCalledWith(expect.objectContaining({ id: "stuck-25" }));
    expect((await x.db.select().from(researchUsage).where(eq(researchUsage.reservationId, "usage-25")))[0].providerFinishedAt).toBe(101);
  });

  it("finds a cancelled subject after more than 25 permitted active crawls", async () => {
    const x = await setup();
    const others = Array.from({ length: 26 }, (_, i) => ({ sourceId: `active-${i}`, sourceRevision: 0, urlFingerprint: "fingerprint", status: "active" as const, currentJobId: `job-${i}` }));
    await x.db.insert(researchSubjects).values(others);
    await x.db.insert(researchJobs).values(others.map((row, i) => ({ jobId: row.currentJobId, sourceId: row.sourceId, generation: 1, urlFingerprint: "fingerprint", urls: [], status: "queued" as const, updatedAt: 0, progress: { crawls: [{ id: `safe-${i}`, done: false }] } })));
    await x.db.insert(researchUsage).values(others.map((row, i) => ({ reservationId: `usage-${i}`, jobId: row.currentJobId, operationKey: "initial", provider: "crawl" as const, providerRequestId: `safe-${i}`, month: "1970-01", status: "started" as const, reservedMicrousd: 30_000, chargedMicrousd: 30_000, priceVersion: "test", updatedAt: 0 })));
    await x.tick(100);
    await acceptResearchEvent(x.db, await buildCompanyResearchEvent({ sourceId: "member", sourceRevision: 1, eventType: "delete", urls: [] }), 101);
    await cancelInactiveResearchCrawls(x.db, x.env, { now: 102, providers: x.api });
    expect(x.api.cancelCrawl).toHaveBeenCalledTimes(1);
    expect(x.api.cancelCrawl).toHaveBeenCalledWith(expect.objectContaining({ id: "crawl-id" }));
  });

  it("uses a fresh manual retry token without removing the previous reservations", async () => {
    const x = await setup();
    x.api.startCrawl = vi.fn(async (args) => { await args.beforePaidCall({ provider: "crawl", inputTokens: 0, outputTokens: 0, costMicroUsd: 30_000, browserSeconds: 1200 }); throw new ProviderError("provider_network_unknown", true); });
    await x.tick(100); await x.tick(160); await x.tick(280);
    const [job] = await x.db.select().from(researchJobs);
    await x.db.update(researchJobs).set({ status: "retry", attempts: 0, progress: { ...job.progress, manualRetryToken: "manual-run" }, nextRunAt: 1000 }).where(eq(researchJobs.jobId, job.jobId));
    await x.tick(1000);
    const usage = await x.db.select().from(researchUsage);
    expect(usage).toHaveLength(4);
    expect(usage[3].operationKey).toContain("manual-run");
    expect(usage.reduce((total, row) => total + row.chargedMicrousd, 0)).toBe(120_000);
  });
});
