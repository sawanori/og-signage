import { and, asc, desc, eq, inArray, isNotNull, isNull, lte, notInArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { startCrawl, pollCrawl, cancelCrawl, ProviderError, type CrawlRecord } from "./crawler";
import { extractProfile } from "./meta";
import { sanitizePage } from "./sanitize";
import { RESEARCH_MODEL, RESEARCH_PROMPT_VERSION } from "./profile-schema";
import type { ResearchEnv } from "./env";
import { researchWrite, type ResearchDb } from "./db/client";
import { researchControls, researchJobs, researchPages, researchProfiles, researchSubjects, researchUsage, researchNow, type ResearchJob, type ResearchProgress } from "./db/schema";
import { assertCurrentResearchJob, cancelUnstartedUsage, finishCrawlRequest, markUsageStarted, markUsageUnknown, recordCrawlRequest, reserveUsage, ResearchBudgetError, settleUsage, setResearchControl } from "./budget";
import { researchHash } from "./intake";
import { isInResearchScope, pagePriority } from "./url-policy";

const LEASE_SECONDS = 120;
const crawlStateSchema = z.object({ url: z.string(), id: z.string(), reservationId: z.string(), startedAt: z.number(), cursor: z.string().nullable(), done: z.boolean(), status: z.string(), total: z.number().default(0), cancelled: z.boolean().default(false) });
const progressSchema = z.object({ crawls: z.array(crawlStateSchema).default([]), reasons: z.array(z.string()).default([]), skipped: z.array(z.object({ url: z.string(), reason: z.string() })).default([]), crawlCompletedAt: z.number().optional(), crawlSuccessful: z.boolean().optional(), contentHash: z.string().optional(), manualRetryToken: z.string().optional() });
export type ResearchJobProgress = z.infer<typeof progressSchema>;
export type ResearchProviders = { startCrawl: typeof startCrawl; pollCrawl: typeof pollCrawl; cancelCrawl: typeof cancelCrawl; extractProfile: typeof extractProfile };
const providers: ResearchProviders = { startCrawl, pollCrawl, cancelCrawl, extractProfile };

export async function claimResearchJob(db: ResearchDb, env: ResearchEnv, now = researchNow()): Promise<ResearchJob | null> {
  return researchWrite(db, async (tx) => {
    const [pause] = await tx.select().from(researchControls).where(eq(researchControls.key, "pause"));
    if (pause?.value.paused === true) return null;
    const [running] = await tx.select({ id: researchJobs.jobId }).from(researchJobs).where(and(eq(researchJobs.status, "running"), sql`${researchJobs.leaseExpiresAt} > ${now}`)).limit(1);
    if (running) return null;
    const sourceIds = (env.RESEARCH_CANARY_SOURCE_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean);
    if (env.RESEARCH_PAID_ENABLED !== "true" && sourceIds.length === 0) return null;
    const rows = await tx.select({ job: researchJobs }).from(researchJobs).innerJoin(researchSubjects, eq(researchSubjects.currentJobId, researchJobs.jobId))
      .where(and(eq(researchSubjects.status, "active"), inArray(researchJobs.status, ["queued", "retry", "running", "budget_exhausted"]), lte(researchJobs.nextRunAt, now), sql`(${researchJobs.leaseExpiresAt} IS NULL OR ${researchJobs.leaseExpiresAt} <= ${now})`, env.RESEARCH_PAID_ENABLED === "true" ? undefined : inArray(researchJobs.sourceId, sourceIds)))
      .orderBy(asc(researchJobs.nextRunAt), asc(researchJobs.createdAt)).limit(1);
    const job = rows[0]?.job;
    if (!job) return null;
    const attempts = job.attempts + (job.status === "running" ? 1 : 0);
    if (attempts >= 3) {
      await tx.update(researchJobs).set({ status: "failed", lastErrorCode: "interrupted_attempt_limit", leaseToken: null, leaseExpiresAt: null, updatedAt: now }).where(eq(researchJobs.jobId, job.jobId));
      return null;
    }
    const [claimed] = await tx.update(researchJobs).set({ status: "running", leaseToken: crypto.randomUUID(), leaseExpiresAt: now + LEASE_SECONDS, attempts, updatedAt: now }).where(eq(researchJobs.jobId, job.jobId)).returning();
    return claimed;
  });
}

export async function checkpointResearchJob(db: ResearchDb, job: ResearchJob, changes: { phase?: string; progress?: ResearchProgress; nextRunAt?: number }, now = researchNow()) {
  return researchWrite(db, async (tx) => {
    await assertCurrentResearchJob(tx, job.jobId, job.leaseToken ?? "", now);
    await tx.update(researchJobs).set({ ...changes, status: "queued", attempts: 0, leaseToken: null, leaseExpiresAt: null, nextRunAt: changes.nextRunAt ?? now + 60, updatedAt: now }).where(eq(researchJobs.jobId, job.jobId));
    if (changes.phase === "extract" && changes.progress?.crawlSuccessful === true && typeof changes.progress.crawlCompletedAt === "number") {
      await tx.update(researchSubjects).set({ lastSuccessfulCrawlAt: changes.progress.crawlCompletedAt, updatedAt: now }).where(eq(researchSubjects.sourceId, job.sourceId));
    }
  });
}

export async function finishResearchJob(db: ResearchDb, job: ResearchJob, profile: Record<string, unknown>, contentHash: string, progress: ResearchJobProgress, now = researchNow()) {
  return researchWrite(db, async (tx) => {
    await assertCurrentResearchJob(tx, job.jobId, job.leaseToken ?? "", now);
    const extracted = typeof profile.extractedAt === "string" ? Math.floor(Date.parse(profile.extractedAt) / 1000) : now;
    if (!Number.isFinite(extracted)) throw new Error("Invalid profile extraction time");
    const profileId = crypto.randomUUID();
    await tx.insert(researchProfiles).values({ profileId, sourceId: job.sourceId, jobId: job.jobId, generation: job.generation, contentHash, schemaVersion: 1, model: RESEARCH_MODEL, promptVersion: RESEARCH_PROMPT_VERSION, payload: profile, extractedAt: extracted, createdAt: now });
    await tx.update(researchSubjects).set({ currentProfileId: profileId, ...(progress.crawlSuccessful ? { lastSuccessfulCrawlAt: progress.crawlCompletedAt ?? now } : {}), updatedAt: now }).where(eq(researchSubjects.sourceId, job.sourceId));
    await tx.update(researchJobs).set({ status: "succeeded", phase: "complete", progress, completedAt: now, updatedAt: now, leaseToken: null, leaseExpiresAt: null }).where(eq(researchJobs.jobId, job.jobId));
  });
}

async function keepCrawlRecord(db: ResearchDb, env: ResearchEnv, job: ResearchJob, record: CrawlRecord, clock: () => number) {
  const now = clock();
  const skip = (reason: string) => [{ url: (record.metadata?.url ?? record.url).slice(0, 2048), reason }];
  let url: URL;
  try { url = new URL(record.metadata?.url ?? record.url); } catch { return skip("invalid_record_url"); }
  if (!isInResearchScope(url.href, job.urls.map((item) => item.url))) return skip("outside_registered_host");
  if (!["completed", 200].includes(record.status)) return skip(`crawl_record_${String(record.status).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 40)}`);
  if (record.metadata?.status !== undefined && (record.metadata.status < 200 || record.metadata.status >= 300)) return skip(`http_status_${record.metadata.status}`);
  url.hash = "";
  const canonicalUrl = url.href;
  const [already] = await db.select().from(researchPages).where(and(eq(researchPages.jobId, job.jobId), eq(researchPages.canonicalUrl, canonicalUrl)));
  const saved = await db.select({ url: researchPages.canonicalUrl }).from(researchPages).where(eq(researchPages.jobId, job.jobId));
  const host = url.hostname.replace(/^www\./, "");
  if (!already && (saved.length >= 100 || saved.filter((page) => new URL(page.url).hostname.replace(/^www\./, "") === host).length >= 50)) return skip("page_limit");
  const sanitized = sanitizePage({ url: canonicalUrl, title: record.metadata?.title, markdown: record.markdown ?? "", html: record.html });
  const skipped: { url: string; reason: string }[] = [...sanitized.unsupportedLinks];
  if (sanitized.status !== "ready") skipped.push({ url: canonicalUrl, reason: sanitized.reasons[0] ?? sanitized.status });
  if (already && already.status !== "storage_pending") return skipped;
  const pageId = already?.pageId ?? crypto.randomUUID();
  const prefix = `sources/${encodeURIComponent(job.sourceId)}/${job.generation}/${pageId}`;
  const markdownKey = sanitized.status === "ready" ? `${prefix}.md` : null;
  const rawKey = record.html ? `${prefix}.html` : null;
  const contentHash = sanitized.status === "ready" ? await researchHash(sanitized.markdown) : null;
  await researchWrite(db, async (tx) => {
    await assertCurrentResearchJob(tx, job.jobId, job.leaseToken ?? "", clock());
    await tx.insert(researchPages).values({ pageId, jobId: job.jobId, sourceId: job.sourceId, canonicalUrl, contentHash, markdownKey, rawKey, title: null, status: "storage_pending", fetchedAt: now, rawExpiresAt: rawKey ? now + 7 * 86_400 : null }).onConflictDoNothing();
  });
  if (rawKey) await env.RESEARCH_BUCKET.put(rawKey, record.html!, { httpMetadata: { contentType: "text/html; charset=utf-8" } });
  if (markdownKey) await env.RESEARCH_BUCKET.put(markdownKey, sanitized.markdown, { httpMetadata: { contentType: "text/markdown; charset=utf-8" } });
  await researchWrite(db, async (tx) => {
    await assertCurrentResearchJob(tx, job.jobId, job.leaseToken ?? "", clock());
    await tx.update(researchPages).set({ status: sanitized.status, exclusionReason: sanitized.reasons.join(",") || (record.status !== "completed" && record.status !== 200 ? String(record.status).slice(0, 100) : null) }).where(eq(researchPages.pageId, pageId));
  });
  return skipped;
}

const nextMonth = (now: number) => {
  const date = new Date(now * 1000);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / 1000;
};

async function failResearchJob(db: ResearchDb, job: ResearchJob, error: unknown, now: number) {
  if (error instanceof ResearchBudgetError && error.code === "stale_job") return;
  const code = error instanceof ResearchBudgetError || error instanceof ProviderError ? error.code : "research_processing_failed";
  const attempts = job.attempts + 1;
  const configuration = error instanceof ProviderError && (error.code.includes("configuration") || error.code.includes("credentials"));
  const budget = error instanceof ResearchBudgetError && error.code === "budget_exhausted";
  const paused = error instanceof ResearchBudgetError && error.code === "paused";
  const configBlocked = configuration || (error instanceof ResearchBudgetError && error.code === "configuration_required");
  const retryable = !(error instanceof ProviderError) || error.retryable;
  const status = paused ? "queued" : budget ? "budget_exhausted" : configBlocked ? "configuration_required" : retryable && attempts < 3 ? "retry" : "failed";
  if (configuration) await setResearchControl(db, `provider:${job.phase === "extract" ? "meta" : "crawl"}`, { blocked: true, reason: code }, now);
  await db.update(researchJobs).set({ status, attempts: paused || budget || configBlocked ? job.attempts : attempts, lastErrorCode: code, leaseToken: null, leaseExpiresAt: null, nextRunAt: budget ? nextMonth(now) : now + Math.max(60 * 2 ** job.attempts, error instanceof ProviderError ? error.retryAfterSeconds ?? 0 : 0), updatedAt: now }).where(and(eq(researchJobs.jobId, job.jobId), eq(researchJobs.leaseToken, job.leaseToken ?? ""), eq(researchJobs.status, "running")));
}

/** Advance one bounded phase. Long crawl work is performed by the provider between ticks. */
export async function runResearchTick(db: ResearchDb, env: ResearchEnv, options: { now?: number; clock?: () => number; providers?: Partial<ResearchProviders> } = {}) {
  const readNow = options.clock ?? (() => options.now ?? researchNow());
  const now = readNow();
  const api = { ...providers, ...options.providers };
  const job = await claimResearchJob(db, env, now);
  if (!job) return { processed: 0 };
  let latestReservation: string | null = null;
  let reservationStarted = false;
  try {
    const progress = progressSchema.parse(job.progress);
    const crawlAuth = { accountId: env.CLOUDFLARE_ACCOUNT_ID ?? "", apiToken: env.CRAWL_API_TOKEN ?? "" };
    if (job.phase === "crawl") {
      const current = progress.crawls.find((crawl) => !crawl.done);
      if (!current && progress.crawls.length < job.urls.length) {
        const index = progress.crawls.length;
        const result = await api.startCrawl({ ...crawlAuth, url: job.urls[index].url, beforePaidCall: async (estimate) => {
          latestReservation = await reserveUsage(db, { ...estimate, jobId: job.jobId, leaseToken: job.leaseToken!, operationKey: `${progress.manualRetryToken ?? "initial"}:crawl:${index}:${job.attempts}` }, env, readNow());
          await markUsageStarted(db, latestReservation, job.leaseToken!, readNow());
          reservationStarted = true;
        } });
        if (!latestReservation) throw new Error("Provider bypassed research budget gate");
        try { await recordCrawlRequest(db, latestReservation, result.id, readNow()); }
        catch (error) {
          // If persistence itself is down, stop a known external job immediately rather than leave it untracked.
          try { await api.cancelCrawl({ ...crawlAuth, id: result.id }); } catch { /* Reservation remains unknown; the persistence error is still surfaced. */ }
          throw error;
        }
        progress.crawls.push({ url: job.urls[index].url, id: result.id, reservationId: latestReservation, startedAt: now, cursor: null, done: false, status: "running", total: 0, cancelled: false });
        await checkpointResearchJob(db, job, { progress }, readNow());
      } else if (current) {
        const result = await api.pollCrawl({ ...crawlAuth, id: current.id, cursor: current.cursor });
        const terminal = ["completed", "cancelled", "canceled", "cancelled_by_user", "errored", "failed"].includes(result.status);
        for (const record of result.records) {
          // A queued record can become completed later; do not advance past it or call it a permanent gap.
          if (!terminal && !["completed", 200].includes(record.status)) continue;
          const skipped = await keepCrawlRecord(db, env, job, record, readNow);
          for (const item of skipped) {
            if (!progress.reasons.includes(item.reason)) progress.reasons.push(item.reason);
            if (progress.skipped.length < 500 && !progress.skipped.some((entry) => entry.url === item.url && entry.reason === item.reason)) progress.skipped.push(item);
          }
        }
        current.cursor = terminal ? result.cursor : null;
        current.total = result.total;
        current.status = result.status;
        if (terminal && !result.cursor) {
          current.done = true;
          if (result.browserSecondsUsed === null) await markUsageUnknown(db, current.reservationId, readNow());
          else await settleUsage(db, current.reservationId, { costMicroUsd: Math.ceil(result.browserSecondsUsed * 25) }, readNow());
          await finishCrawlRequest(db, current.reservationId, readNow());
          if (result.status !== "completed") progress.reasons.push(`crawl_${result.status}`);
          if (result.total >= 50) progress.reasons.push("page_limit");
        } else if (!terminal && readNow() - current.startedAt >= 20 * 60) {
          await api.cancelCrawl({ ...crawlAuth, id: current.id });
          current.done = true; current.cancelled = true; current.status = "timed_out";
          progress.reasons.push("crawl_time_limit");
          await markUsageUnknown(db, current.reservationId, readNow());
          await finishCrawlRequest(db, current.reservationId, readNow());
        }
        await checkpointResearchJob(db, job, { progress }, readNow());
      } else {
        progress.crawlCompletedAt = now;
        progress.crawlSuccessful = progress.crawls.every((crawl) => crawl.status === "completed");
        await checkpointResearchJob(db, job, { phase: "extract", progress }, readNow());
      }
    } else if (job.phase === "extract") {
      const rows = await db.select().from(researchPages).where(eq(researchPages.jobId, job.jobId)).orderBy(asc(researchPages.canonicalUrl));
      const ready = rows.filter((row) => row.status === "ready" && row.markdownKey && row.contentHash);
      const deduplicated = ready.filter((row, index) => ready.findIndex((candidate) => candidate.contentHash === row.contentHash) === index).sort((a, b) => pagePriority(a.canonicalUrl) - pagePriority(b.canonicalUrl) || a.canonicalUrl.localeCompare(b.canonicalUrl));
      const unique: typeof ready = [];
      const pages = [];
      let inputBytes = 0;
      for (const row of deduplicated) {
        const object = await env.RESEARCH_BUCKET.get(row.markdownKey!);
        if (!object) throw new Error("Research evidence object is missing");
        const markdown = await object.text();
        const size = new TextEncoder().encode(markdown).length;
        if (inputBytes + size > 450_000) { if (!progress.reasons.includes("input_budget_limit")) progress.reasons.push("input_budget_limit"); progress.skipped.push({ url: row.canonicalUrl, reason: "input_budget_limit" }); continue; }
        inputBytes += size; unique.push(row);
        pages.push({ sourceId: `page-${(await researchHash(row.canonicalUrl)).slice(0, 32)}`, markdown });
      }
      const contentHash = await researchHash(JSON.stringify(unique.map((page) => [page.canonicalUrl, page.contentHash])));
      progress.contentHash = contentHash;
      if (pages.length === 0) {
        await researchWrite(db, async (tx) => {
          await assertCurrentResearchJob(tx, job.jobId, job.leaseToken!, readNow());
          await tx.update(researchJobs).set({ status: "failed", phase: "complete", progress, lastErrorCode: "no_eligible_pages", completedAt: now, updatedAt: now, leaseToken: null, leaseExpiresAt: null }).where(eq(researchJobs.jobId, job.jobId));
          if (progress.crawlSuccessful) await tx.update(researchSubjects).set({ lastSuccessfulCrawlAt: progress.crawlCompletedAt ?? now, updatedAt: now }).where(eq(researchSubjects.sourceId, job.sourceId));
        });
        return { processed: 1 };
      }
      const [cached] = await db.select().from(researchProfiles).where(and(eq(researchProfiles.sourceId, job.sourceId), eq(researchProfiles.contentHash, contentHash), eq(researchProfiles.model, RESEARCH_MODEL), eq(researchProfiles.promptVersion, RESEARCH_PROMPT_VERSION))).orderBy(desc(researchProfiles.createdAt)).limit(1);
      let profile: Record<string, unknown>;
      if (cached) profile = { ...cached.payload, generation: job.generation };
      else {
        const result = await api.extractProfile({ apiKey: env.MODEL_API_KEY ?? "", pages, sourceId: job.sourceId, generation: job.generation, now: new Date(readNow() * 1000), beforePaidCall: async (estimate) => {
          latestReservation = await reserveUsage(db, { ...estimate, jobId: job.jobId, leaseToken: job.leaseToken!, operationKey: `${progress.manualRetryToken ?? "initial"}:meta:extract:${job.attempts}` }, env, readNow());
          await markUsageStarted(db, latestReservation, job.leaseToken!, readNow());
          reservationStarted = true;
        } });
        if (!latestReservation) throw new Error("Provider bypassed research budget gate");
        await settleUsage(db, latestReservation, result.usage, readNow());
        profile = result.profile;
      }
      const sources = await Promise.all(unique.map(async (row) => ({ sourceId: `page-${(await researchHash(row.canonicalUrl)).slice(0, 32)}`, url: row.canonicalUrl, contentHash: row.contentHash, markdownKey: row.markdownKey, fetchedAt: new Date(row.fetchedAt * 1000).toISOString() })));
      const skipped = [...progress.skipped, ...rows.filter((row) => row.status !== "ready").map((row) => ({ url: row.canonicalUrl, reason: row.exclusionReason ?? row.status }))].filter((item, index, all) => all.findIndex((other) => other.url === item.url && other.reason === item.reason) === index);
      const coverage = { inputUrls: job.urls.map((item) => item.url), fetched: rows.length, processed: unique.length, skipped, reasons: [...new Set(progress.reasons)], status: skipped.length || progress.reasons.length || !progress.crawlSuccessful ? "partial" : "complete", lastFetchedAt: new Date((progress.crawlCompletedAt ?? now) * 1000).toISOString() };
      await finishResearchJob(db, job, { ...profile, sources, coverage }, contentHash, progress, readNow());
    } else throw new Error("Unknown research phase");
    return { processed: 1 };
  } catch (error) {
    if (latestReservation) {
      if (reservationStarted && error instanceof ProviderError && error.usage) await settleUsage(db, latestReservation, error.usage, readNow());
      else if (reservationStarted) await markUsageUnknown(db, latestReservation, readNow());
      else await cancelUnstartedUsage(db, latestReservation, readNow());
    }
    await failResearchJob(db, job, error, readNow());
    return { processed: 1 };
  }
}

/** Deletion/pause must cancel already-started crawls even when paid execution is disabled. */
export async function cancelInactiveResearchCrawls(db: ResearchDb, env: ResearchEnv, options: { now?: number; providers?: Partial<ResearchProviders> } = {}) {
  const now = options.now ?? researchNow();
  const api = { ...providers, ...options.providers };
  const [pause] = await db.select().from(researchControls).where(eq(researchControls.key, "pause"));
  const canaryIds = (env.RESEARCH_CANARY_SOURCE_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  const disallowed = pause?.value.paused === true ? sql`1 = 1` : env.RESEARCH_PAID_ENABLED === "true" ? sql`1 = 0` : canaryIds.length ? notInArray(researchJobs.sourceId, canaryIds) : sql`1 = 1`;
  const orphan = sql`NOT EXISTS (SELECT 1 FROM json_each(json_extract(${researchJobs.progress}, '$.crawls')) AS c WHERE json_extract(c.value, '$.id') = ${researchUsage.providerRequestId}) AND (${researchJobs.leaseToken} IS NULL OR ${researchJobs.leaseToken} != ${researchUsage.leaseTokenAtStart} OR ${researchJobs.leaseExpiresAt} <= ${now})`;
  const rows = await db.select({ job: researchJobs, usage: researchUsage }).from(researchUsage).innerJoin(researchJobs, eq(researchJobs.jobId, researchUsage.jobId)).where(and(eq(researchUsage.provider, "crawl"), isNotNull(researchUsage.providerRequestId), isNull(researchUsage.providerFinishedAt), or(inArray(researchJobs.status, ["superseded", "failed"]), disallowed, orphan))).orderBy(asc(researchUsage.updatedAt)).limit(25);
  let cancelled = 0;
  let failed = 0;
  for (const { job, usage } of rows) {
    const parsed = progressSchema.safeParse(job.progress);
    try {
      await api.cancelCrawl({ accountId: env.CLOUDFLARE_ACCOUNT_ID ?? "", apiToken: env.CRAWL_API_TOKEN ?? "", id: usage.providerRequestId! });
      await markUsageUnknown(db, usage.reservationId, now);
      await finishCrawlRequest(db, usage.reservationId, now);
      cancelled++;
      if (parsed.success) {
        for (const crawl of parsed.data.crawls.filter((item) => item.id === usage.providerRequestId)) { crawl.cancelled = true; crawl.done = true; crawl.status = "cancelled"; }
        await db.update(researchJobs).set({ progress: parsed.data, updatedAt: now }).where(and(eq(researchJobs.jobId, job.jobId), eq(researchJobs.updatedAt, job.updatedAt), eq(researchJobs.progress, job.progress)));
      }
    } catch {
      failed++;
      await db.update(researchJobs).set({ lastErrorCode: "crawl_cancel_failed" }).where(eq(researchJobs.jobId, job.jobId));
    }
  }
  return { cancelled, failed };
}
