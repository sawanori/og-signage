import { and, eq, inArray, sql } from "drizzle-orm";
import { paidSourceAllowed, type ResearchEnv } from "./env";
import { researchWrite, type ResearchDb, type ResearchTransaction } from "./db/client";
import { researchControls, researchJobs, researchSubjects, researchUsage, researchNow } from "./db/schema";

export const RESEARCH_MONTHLY_MICROUSD = 5_000_000;
export const RESEARCH_JOB_AI_MICROUSD = 100_000;
export const RESEARCH_JOB_INPUT_TOKENS = 500_000;
export const RESEARCH_JOB_OUTPUT_TOKENS = 50_000;
export const RESEARCH_PRICE_VERSION = "2026-10-01";
export class ResearchBudgetError extends Error {
  constructor(readonly code: "paused" | "budget_exhausted" | "configuration_required" | "stale_job" | "call_already_started" | "reservation_expired") { super(code); }
}
export type ReserveResearchUsage = {
  jobId: string; leaseToken: string; operationKey: string; provider: "meta" | "crawl";
  inputTokens: number; outputTokens: number; costMicroUsd: number;
};
export type ResearchUsageActual = { costMicroUsd: number; inputTokens?: number; outputTokens?: number; cachedInputTokens?: number; reasoningTokens?: number };
export const researchMonth = (now: number) => new Date(now * 1000).toISOString().slice(0, 7);

export async function setResearchControl(db: ResearchDb, key: string, value: Record<string, unknown>, now = researchNow()) {
  await db.insert(researchControls).values({ key, value, updatedAt: now }).onConflictDoUpdate({ target: researchControls.key, set: { value, updatedAt: now } });
}

export async function assertCurrentResearchJob(tx: ResearchTransaction, jobId: string, leaseToken: string, now: number) {
  const [job] = await tx.select().from(researchJobs).where(eq(researchJobs.jobId, jobId));
  if (!job || job.status !== "running" || job.leaseToken !== leaseToken || job.leaseExpiresAt === null || job.leaseExpiresAt <= now) throw new ResearchBudgetError("stale_job");
  const [subject] = await tx.select().from(researchSubjects).where(eq(researchSubjects.sourceId, job.sourceId));
  if (!subject || subject.status !== "active" || subject.currentJobId !== jobId || subject.urlFingerprint !== job.urlFingerprint) throw new ResearchBudgetError("stale_job");
  return { job, subject };
}

export async function reserveUsage(db: ResearchDb, input: ReserveResearchUsage, env: Pick<ResearchEnv, "RESEARCH_PAID_ENABLED" | "RESEARCH_CANARY_SOURCE_IDS"> = {}, now = researchNow()) {
  for (const value of [input.inputTokens, input.outputTokens, input.costMicroUsd]) if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid research usage estimate");
  if (input.costMicroUsd <= 0 || !input.operationKey) throw new Error("Paid calls require a positive reservation and an operation key");
  return researchWrite(db, async (tx) => {
    const { job } = await assertCurrentResearchJob(tx, input.jobId, input.leaseToken, now);
    if (!paidSourceAllowed(env, job.sourceId)) throw new ResearchBudgetError("paused");
    const controls = await tx.select().from(researchControls).where(inArray(researchControls.key, ["pause", `provider:${input.provider}`]));
    if (controls.some((row) => row.key === "pause" && row.value.paused === true)) throw new ResearchBudgetError("paused");
    if (controls.some((row) => row.key === `provider:${input.provider}` && row.value.blocked === true)) throw new ResearchBudgetError("configuration_required");
    const [existing] = await tx.select().from(researchUsage).where(and(eq(researchUsage.jobId, input.jobId), eq(researchUsage.operationKey, input.operationKey)));
    if (existing && existing.status !== "cancelled") throw new ResearchBudgetError("call_already_started");
    const [month] = await tx.select({ cost: sql<number>`coalesce(sum(${researchUsage.chargedMicrousd}), 0)` }).from(researchUsage).where(and(eq(researchUsage.provider, input.provider), eq(researchUsage.month, researchMonth(now))));
    if (Number(month.cost) + input.costMicroUsd > RESEARCH_MONTHLY_MICROUSD) throw new ResearchBudgetError("budget_exhausted");
    if (input.provider === "meta") {
      const [jobUsage] = await tx.select({
        cost: sql<number>`coalesce(sum(${researchUsage.chargedMicrousd}), 0)`,
        input: sql<number>`coalesce(sum(case when ${researchUsage.status} = 'cancelled' then 0 when ${researchUsage.status} = 'settled' then ${researchUsage.inputTokens} else ${researchUsage.inputTokenLimit} end), 0)`,
        output: sql<number>`coalesce(sum(case when ${researchUsage.status} = 'cancelled' then 0 when ${researchUsage.status} = 'settled' then ${researchUsage.outputTokens} else ${researchUsage.outputTokenLimit} end), 0)`,
      }).from(researchUsage).where(and(eq(researchUsage.jobId, input.jobId), eq(researchUsage.provider, "meta")));
      if (Number(jobUsage.cost) + input.costMicroUsd > RESEARCH_JOB_AI_MICROUSD || Number(jobUsage.input) + input.inputTokens > RESEARCH_JOB_INPUT_TOKENS || Number(jobUsage.output) + input.outputTokens > RESEARCH_JOB_OUTPUT_TOKENS) throw new ResearchBudgetError("budget_exhausted");
    }
    const reservationId = existing?.reservationId ?? crypto.randomUUID();
    const values = { reservationId, jobId: input.jobId, operationKey: input.operationKey, provider: input.provider, month: researchMonth(now), status: "reserved" as const, reservedMicrousd: input.costMicroUsd, chargedMicrousd: input.costMicroUsd, inputTokenLimit: input.inputTokens, outputTokenLimit: input.outputTokens, priceVersion: RESEARCH_PRICE_VERSION, leaseTokenAtStart: input.leaseToken, createdAt: now, updatedAt: now };
    // A cancelled reservation never reached the network; the same logical operation may be reserved again.
    if (existing) await tx.update(researchUsage).set(values).where(eq(researchUsage.reservationId, reservationId));
    else await tx.insert(researchUsage).values(values);
    return reservationId;
  });
}

/** Mark before network I/O: an interrupted call retains its reservation. */
export async function markUsageStarted(db: ResearchDb, reservationId: string, leaseToken: string, now = researchNow()) {
  return researchWrite(db, async (tx) => {
    const [usage] = await tx.select().from(researchUsage).where(eq(researchUsage.reservationId, reservationId));
    if (!usage || usage.status !== "reserved") throw new ResearchBudgetError("call_already_started");
    await assertCurrentResearchJob(tx, usage.jobId, leaseToken, now);
    const controls = await tx.select().from(researchControls).where(inArray(researchControls.key, ["pause", `provider:${usage.provider}`]));
    if (controls.some((row) => row.key === "pause" && row.value.paused === true)) throw new ResearchBudgetError("paused");
    if (controls.some((row) => row.key === `provider:${usage.provider}` && row.value.blocked === true)) throw new ResearchBudgetError("configuration_required");
    if (usage.month !== researchMonth(now)) throw new ResearchBudgetError("reservation_expired");
    await tx.update(researchUsage).set({ status: "started", updatedAt: now }).where(eq(researchUsage.reservationId, reservationId));
  });
}

export async function markUsageUnknown(db: ResearchDb, reservationId: string, now = researchNow()) {
  await db.update(researchUsage).set({ status: "unknown", updatedAt: now }).where(and(eq(researchUsage.reservationId, reservationId), inArray(researchUsage.status, ["reserved", "started"])));
}

export async function settleUsage(db: ResearchDb, reservationId: string, actual: ResearchUsageActual, now = researchNow()) {
  for (const value of Object.values(actual)) if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new Error("Invalid research actual usage");
  await researchWrite(db, async (tx) => {
    const [usage] = await tx.select().from(researchUsage).where(eq(researchUsage.reservationId, reservationId));
    if (!usage) throw new Error("Research usage reservation does not exist");
    if (usage.status === "settled") return;
    if (usage.status === "cancelled") throw new Error("Cannot settle a cancelled research reservation");
    if (usage.provider === "meta" && (actual.inputTokens === undefined || actual.outputTokens === undefined)) throw new Error("Meta usage must include input and output tokens");
    await tx.update(researchUsage).set({ status: "settled", chargedMicrousd: actual.costMicroUsd, inputTokens: actual.inputTokens ?? null, outputTokens: actual.outputTokens ?? null, cachedTokens: actual.cachedInputTokens ?? null, reasoningTokens: actual.reasoningTokens ?? null, updatedAt: now }).where(eq(researchUsage.reservationId, reservationId));
    if (actual.costMicroUsd > usage.reservedMicrousd || (usage.provider === "meta" && ((actual.inputTokens ?? 0) > usage.inputTokenLimit || (actual.outputTokens ?? 0) > usage.outputTokenLimit))) {
      await tx.insert(researchControls).values({ key: "pause", value: { paused: true, reason: "usage_exceeded_reservation" }, updatedAt: now }).onConflictDoUpdate({ target: researchControls.key, set: { value: { paused: true, reason: "usage_exceeded_reservation" }, updatedAt: now } });
    }
  });
}

export async function cancelUnstartedUsage(db: ResearchDb, reservationId: string, now = researchNow()) {
  await db.update(researchUsage).set({ status: "cancelled", chargedMicrousd: 0, updatedAt: now }).where(and(eq(researchUsage.reservationId, reservationId), eq(researchUsage.status, "reserved")));
}

/** Track a returned external ID even when its subject/lease changed while awaiting the response. */
export async function recordCrawlRequest(db: ResearchDb, reservationId: string, providerRequestId: string, now = researchNow()) {
  await db.update(researchUsage).set({ providerRequestId, updatedAt: now }).where(and(eq(researchUsage.reservationId, reservationId), eq(researchUsage.provider, "crawl")));
}

export async function finishCrawlRequest(db: ResearchDb, reservationId: string, now = researchNow()) {
  await db.update(researchUsage).set({ providerFinishedAt: now, updatedAt: now }).where(eq(researchUsage.reservationId, reservationId));
}
