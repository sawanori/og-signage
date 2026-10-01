import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { buildCompanyResearchEvent } from "../../lib/company-research-contract";
import { acceptResearchEvent } from "../../research/intake";
import { claimResearchJob } from "../../research/jobs";
import { cancelUnstartedUsage, markUsageStarted, markUsageUnknown, reserveUsage, settleUsage, setResearchControl } from "../../research/budget";
import { researchControls, researchJobs, researchUsage } from "../../research/db/schema";
import type { ResearchEnv } from "../../research/env";
import { openTestResearchDatabase } from "./db-helper";

const connections: Awaited<ReturnType<typeof openTestResearchDatabase>>[] = [];
afterEach(() => { for (const c of connections.splice(0)) c.close(); });
const env: ResearchEnv = { RESEARCH_PAID_ENABLED: "true", RESEARCH_BUCKET: { put: async () => {}, get: async () => null, delete: async () => {} } };
async function setup(now = 100) {
  const c = await openTestResearchDatabase(); connections.push(c);
  await acceptResearchEvent(c.db, await buildCompanyResearchEvent({ sourceId: "member", sourceRevision: 0, eventType: "upsert", urls: [{ slot: 1, url: "https://example.com/" }] }), now);
  const job = (await claimResearchJob(c.db, env, now))!;
  return { ...c, job, input: { jobId: job.jobId, leaseToken: job.leaseToken!, operationKey: "first", provider: "meta" as const, costMicroUsd: 60_000, inputTokens: 1000, outputTokens: 1000 } };
}

describe("research budget reservations", () => {
  it("serializes competing reservations against the job balance across DB connections", async () => {
    const x = await setup(); const second = x.openAnother();
    try {
      const results = await Promise.allSettled([reserveUsage(x.db, x.input, env, 100), reserveUsage(second.db, { ...x.input, operationKey: "second" }, env, 100)]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { code: "budget_exhausted" } });
      expect(await x.db.select().from(researchUsage)).toHaveLength(1);
    } finally { second.close(); }
  });

  it("counts unknown requests conservatively and releases only a known settlement difference", async () => {
    const x = await setup();
    const id = await reserveUsage(x.db, x.input, env, 100);
    await markUsageStarted(x.db, id, x.job.leaseToken!, 100);
    await markUsageUnknown(x.db, id, 101);
    await expect(reserveUsage(x.db, { ...x.input, operationKey: "second" }, env, 101)).rejects.toMatchObject({ code: "budget_exhausted" });
    await settleUsage(x.db, id, { costMicroUsd: 10_000, inputTokens: 100, outputTokens: 100, cachedInputTokens: 20, reasoningTokens: 50 }, 102);
    await reserveUsage(x.db, { ...x.input, operationKey: "second" }, env, 102);
    const [usage] = await x.db.select().from(researchUsage).where(eq(researchUsage.reservationId, id));
    expect(usage).toMatchObject({ status: "settled", chargedMicrousd: 10_000, cachedTokens: 20, reasoningTokens: 50 });
  });

  it("enforces input and output totals including unknown attempts", async () => {
    const x = await setup();
    await reserveUsage(x.db, { ...x.input, costMicroUsd: 1, inputTokens: 500_000, outputTokens: 50_000 }, env, 100);
    await expect(reserveUsage(x.db, { ...x.input, operationKey: "another", costMicroUsd: 1, inputTokens: 1, outputTokens: 0 }, env, 100)).rejects.toMatchObject({ code: "budget_exhausted" });
    await expect(reserveUsage(x.db, { ...x.input, operationKey: "output", costMicroUsd: 1, inputTokens: 0, outputTokens: 1 }, env, 100)).rejects.toMatchObject({ code: "budget_exhausted" });
  });

  it("keeps crawl and Meta monthly balances separate and does not borrow from next month before it starts", async () => {
    const now = Date.UTC(2026, 9, 31, 23, 59, 30) / 1000;
    const x = await setup(now);
    await reserveUsage(x.db, { ...x.input, provider: "crawl", costMicroUsd: 5_000_000, inputTokens: 0, outputTokens: 0 }, env, now);
    await expect(reserveUsage(x.db, { ...x.input, operationKey: "crawl-next", provider: "crawl", costMicroUsd: 1 }, env, now)).rejects.toMatchObject({ code: "budget_exhausted" });
    await reserveUsage(x.db, { ...x.input, operationKey: "meta" }, env, now);
    await reserveUsage(x.db, { ...x.input, operationKey: "new-month", provider: "crawl", costMicroUsd: 30_000, inputTokens: 0, outputTokens: 0 }, env, now + 31);
    expect((await x.db.select().from(researchUsage)).map((row) => row.month)).toEqual(["2026-10", "2026-10", "2026-11"]);
  });

  it("rechecks pause/provider block and UTC month immediately before the network start", async () => {
    const now = Date.UTC(2026, 9, 31, 23, 59, 30) / 1000;
    const x = await setup(now);
    const id = await reserveUsage(x.db, x.input, env, now);
    await setResearchControl(x.db, "pause", { paused: true }, now);
    await expect(markUsageStarted(x.db, id, x.job.leaseToken!, now)).rejects.toMatchObject({ code: "paused" });
    await setResearchControl(x.db, "pause", { paused: false }, now);
    await setResearchControl(x.db, "provider:meta", { blocked: true }, now);
    await expect(markUsageStarted(x.db, id, x.job.leaseToken!, now)).rejects.toMatchObject({ code: "configuration_required" });
    await setResearchControl(x.db, "provider:meta", { blocked: false }, now);
    await expect(markUsageStarted(x.db, id, x.job.leaseToken!, now + 31)).rejects.toMatchObject({ code: "reservation_expired" });
    await cancelUnstartedUsage(x.db, id, now + 31);
    expect((await x.db.select().from(researchUsage))[0].chargedMicrousd).toBe(0);
    expect(await reserveUsage(x.db, x.input, env, now + 31)).toBe(id);
  });

  it("refuses a deleted subject and expired lease before any reservation", async () => {
    const x = await setup();
    await expect(reserveUsage(x.db, x.input, env, 221)).rejects.toMatchObject({ code: "stale_job" });
    await acceptResearchEvent(x.db, await buildCompanyResearchEvent({ sourceId: "member", sourceRevision: 1, eventType: "delete", urls: [] }), 101);
    await expect(reserveUsage(x.db, x.input, env, 102)).rejects.toMatchObject({ code: "stale_job" });
    expect(await x.db.select().from(researchUsage)).toHaveLength(0);
  });

  it("stores unexpectedly high actual usage and pauses rather than concealing overspend", async () => {
    const x = await setup(); const id = await reserveUsage(x.db, { ...x.input, costMicroUsd: 100 }, env, 100);
    await markUsageStarted(x.db, id, x.job.leaseToken!, 100);
    await settleUsage(x.db, id, { costMicroUsd: 101, inputTokens: 10, outputTokens: 10 }, 101);
    expect((await x.db.select().from(researchUsage))[0].chargedMicrousd).toBe(101);
    expect((await x.db.select().from(researchControls))[0].value).toMatchObject({ paused: true, reason: "usage_exceeded_reservation" });
  });

  it("canary authorization is enforced inside the paid-call gate", async () => {
    const x = await setup();
    await expect(reserveUsage(x.db, x.input, {}, 100)).rejects.toMatchObject({ code: "paused" });
    await expect(reserveUsage(x.db, x.input, { RESEARCH_CANARY_SOURCE_IDS: "other" }, 100)).rejects.toMatchObject({ code: "paused" });
    await reserveUsage(x.db, x.input, { RESEARCH_CANARY_SOURCE_IDS: "member" }, 100);
    expect(await x.db.select().from(researchUsage)).toHaveLength(1);
    expect((await x.db.select().from(researchJobs))[0].status).toBe("running");
  });
});
