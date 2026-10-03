import { eq } from "drizzle-orm";
import { companyResearchEventSchema, computeResearchFingerprint, type CompanyResearchEvent } from "../lib/company-research-contract";
import { researchWrite, type ResearchDb } from "./db/client";
import { researchEvents, researchJobs, researchSubjects, researchNow } from "./db/schema";

const THIRTY_DAYS = 30 * 86_400;
export const RESEARCH_DELETE_GRACE_SECONDS = 7 * 86_400;
export class IntakeError extends Error {
  constructor(readonly status: 400 | 409 | 413, readonly code: string) { super(code); }
}
export async function researchHash(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))].map((v) => v.toString(16).padStart(2, "0")).join("");
}

export async function acceptResearchEvent(db: ResearchDb, input: unknown, now = researchNow()): Promise<{ eventId: string; status: "accepted" }> {
  const parsed = companyResearchEventSchema.safeParse(input);
  if (!parsed.success) throw new IntakeError(400, "invalid_event");
  const event: CompanyResearchEvent = parsed.data;
  if (await computeResearchFingerprint(event.urls) !== event.urlFingerprint) throw new IntakeError(400, "invalid_fingerprint");
  const payloadHash = await researchHash(JSON.stringify(event));
  const accepted = { eventId: event.eventId, status: "accepted" as const };
  return researchWrite(db, async (tx) => {
    const [existing] = await tx.select().from(researchEvents).where(eq(researchEvents.eventId, event.eventId));
    if (existing) {
      if (existing.payloadHash !== payloadHash) throw new IntakeError(409, "event_conflict");
      return accepted;
    }
    await tx.insert(researchEvents).values({ eventId: event.eventId, payloadHash, sourceId: event.sourceId, sourceRevision: event.sourceRevision, eventType: event.eventType, receivedAt: now });
    const [subject] = await tx.select().from(researchSubjects).where(eq(researchSubjects.sourceId, event.sourceId));
    if (subject && (event.sourceRevision <= subject.sourceRevision || subject.status === "deleted")) return accepted;
    if (!subject) await tx.insert(researchSubjects).values({ sourceId: event.sourceId, sourceRevision: event.sourceRevision, urlFingerprint: event.urlFingerprint, status: "active", createdAt: now, updatedAt: now });

    if (event.eventType !== "upsert") {
      await tx.update(researchJobs).set({ status: "superseded", leaseToken: null, leaseExpiresAt: null, purgeAfter: now + RESEARCH_DELETE_GRACE_SECONDS, updatedAt: now }).where(eq(researchJobs.sourceId, event.sourceId));
      await tx.update(researchSubjects).set({ sourceRevision: event.sourceRevision, urlFingerprint: event.urlFingerprint, status: event.eventType === "delete" ? "deleted" : "revoked", currentJobId: null, currentProfileId: null, lastSuccessfulCrawlAt: null, purgeAfter: now + RESEARCH_DELETE_GRACE_SECONDS, purgedAt: null, updatedAt: now }).where(eq(researchSubjects.sourceId, event.sourceId));
      return accepted;
    }

    const [currentJob] = subject?.currentJobId ? await tx.select().from(researchJobs).where(eq(researchJobs.jobId, subject.currentJobId)) : [];
    const sameUrls = subject?.status === "active" && subject.urlFingerprint === event.urlFingerprint;
    const inProgress = currentJob && ["queued", "running", "retry", "budget_exhausted", "configuration_required"].includes(currentJob.status);
    // 30日以内の結果を使い回すのは、前回の処理で企業データができていたときだけ。
    // 失敗していたら、同じ URL のまま保存し直すだけでやり直す（2026-10-03 ユーザー指示）
    const fresh = currentJob?.status === "succeeded" && subject?.lastSuccessfulCrawlAt !== null && subject?.lastSuccessfulCrawlAt !== undefined && now - subject.lastSuccessfulCrawlAt < THIRTY_DAYS;
    if (sameUrls && (inProgress || fresh)) {
      await tx.update(researchSubjects).set({ sourceRevision: event.sourceRevision, updatedAt: now }).where(eq(researchSubjects.sourceId, event.sourceId));
      return accepted;
    }
    if (currentJob && !["succeeded", "failed"].includes(currentJob.status)) await tx.update(researchJobs).set({ status: "superseded", leaseToken: null, leaseExpiresAt: null, updatedAt: now }).where(eq(researchJobs.jobId, currentJob.jobId));
    const jobId = crypto.randomUUID();
    const generation = (subject?.generation ?? 0) + 1;
    await tx.insert(researchJobs).values({ jobId, sourceId: event.sourceId, generation, urlFingerprint: event.urlFingerprint, urls: event.urls, nextRunAt: now, createdAt: now, updatedAt: now });
    await tx.update(researchSubjects).set({ sourceRevision: event.sourceRevision, urlFingerprint: event.urlFingerprint, status: "active", generation, currentJobId: jobId, currentProfileId: sameUrls ? subject.currentProfileId : null, lastSuccessfulCrawlAt: sameUrls ? subject.lastSuccessfulCrawlAt : null, purgeAfter: null, purgedAt: null, updatedAt: now }).where(eq(researchSubjects.sourceId, event.sourceId));
    return accepted;
  });
}

async function boundedJson(request: Request): Promise<unknown> {
  if (!request.body) throw new IntakeError(400, "invalid_event");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) { await reader.cancel(); throw new IntakeError(413, "event_too_large"); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(size);
  let position = 0;
  for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.length; }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new IntakeError(400, "invalid_json"); }
}

export async function handleIntake(request: Request, db: ResearchDb, now = researchNow()): Promise<Response> {
  if (new URL(request.url).pathname !== "/internal/sources") return new Response(null, { status: 404 });
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  try {
    return Response.json(await acceptResearchEvent(db, await boundedJson(request), now), { status: 202, headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof IntakeError) return Response.json({ error: { code: error.code } }, { status: error.status });
    // DB errors can contain connection data. Only the outcome crosses this boundary.
    return Response.json({ error: { code: "research_unavailable" } }, { status: 503 });
  }
}
