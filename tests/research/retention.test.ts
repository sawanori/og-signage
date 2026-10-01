import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { buildCompanyResearchEvent } from "../../lib/company-research-contract";
import { acceptResearchEvent } from "../../research/intake";
import { purgeResearchData } from "../../research/retention";
import { researchJobs, researchPages, researchProfiles, researchSubjects } from "../../research/db/schema";
import type { ResearchBucket } from "../../research/env";
import { openTestResearchDatabase } from "./db-helper";

const connections: Awaited<ReturnType<typeof openTestResearchDatabase>>[] = [];
afterEach(() => { for (const c of connections.splice(0)) c.close(); });
async function setup() {
  const c = await openTestResearchDatabase(); connections.push(c);
  await acceptResearchEvent(c.db, await buildCompanyResearchEvent({ sourceId: "member", sourceRevision: 0, eventType: "upsert", urls: [{ slot: 1, url: "https://example.com/" }] }), 100);
  const [job] = await c.db.select().from(researchJobs);
  const objects = new Set(["raw.html", "clean.md"]);
  const bucket: ResearchBucket = { get: async () => null, put: async () => {}, delete: vi.fn(async (keys) => { for (const key of typeof keys === "string" ? [keys] : keys) objects.delete(key); }) };
  await c.db.insert(researchPages).values({ pageId: "page", jobId: job.jobId, sourceId: "member", canonicalUrl: "https://example.com/", contentHash: "hash", rawKey: "raw.html", markdownKey: "clean.md", status: "ready", fetchedAt: 100, rawExpiresAt: 100 + 7 * 86_400 });
  await c.db.insert(researchProfiles).values({ profileId: "profile", sourceId: "member", jobId: job.jobId, generation: 1, contentHash: "hash", schemaVersion: 1, model: "model", promptVersion: "v1", payload: { evidence: "private" }, extractedAt: 100, createdAt: 100 });
  await c.db.update(researchJobs).set({ status: "succeeded", completedAt: 100 }).where(eq(researchJobs.jobId, job.jobId));
  await c.db.update(researchSubjects).set({ currentProfileId: "profile" }).where(eq(researchSubjects.sourceId, "member"));
  return { ...c, job, objects, bucket };
}

describe("research retention", () => {
  it("expires raw HTML after seven days while retaining current evidence beyond ninety days", async () => {
    const x = await setup();
    await purgeResearchData(x.db, x.bucket, 100 + 91 * 86_400);
    expect(x.objects.has("raw.html")).toBe(false);
    expect(x.objects.has("clean.md")).toBe(true);
    expect(await x.db.select().from(researchProfiles)).toHaveLength(1);
  });

  it("retries failed R2 deletion, purges revoked data, and keeps the source tombstone", async () => {
    const x = await setup();
    await acceptResearchEvent(x.db, await buildCompanyResearchEvent({ sourceId: "member", sourceRevision: 1, eventType: "revoke", urls: [] }), 101);
    const goodDelete = x.bucket.delete;
    x.bucket.delete = vi.fn(async () => { throw new Error("injected"); });
    const first = await purgeResearchData(x.db, x.bucket, 101 + 7 * 86_400);
    expect(first.failed).toBeGreaterThan(0);
    expect(await x.db.select().from(researchPages)).toHaveLength(1);
    x.bucket.delete = goodDelete;
    await purgeResearchData(x.db, x.bucket, 102 + 7 * 86_400);
    expect(await x.db.select().from(researchPages)).toHaveLength(0);
    expect(await x.db.select().from(researchProfiles)).toHaveLength(0);
    expect((await x.db.select().from(researchSubjects))[0]).toMatchObject({ status: "revoked", sourceRevision: 1, purgedAt: 102 + 7 * 86_400 });
    expect((await x.db.select().from(researchJobs))[0]).toMatchObject({ urls: [], progress: {}, phase: "purged" });
  });

  it("retains the old generation's seven-day deadline if URLs are re-added before purge", async () => {
    const x = await setup();
    await acceptResearchEvent(x.db, await buildCompanyResearchEvent({ sourceId: "member", sourceRevision: 1, eventType: "revoke", urls: [] }), 101);
    await acceptResearchEvent(x.db, await buildCompanyResearchEvent({ sourceId: "member", sourceRevision: 2, eventType: "upsert", urls: [{ slot: 1, url: "https://example.com/new" }] }), 102);
    await purgeResearchData(x.db, x.bucket, 101 + 7 * 86_400);
    expect(await x.db.select().from(researchPages)).toHaveLength(0);
    const [subject] = await x.db.select().from(researchSubjects);
    expect(subject.status).toBe("active");
    expect(subject.currentJobId).not.toBe(x.job.jobId);
  });

  it("excludes protected current jobs before LIMIT so they cannot starve due deletions", async () => {
    const x = await setup();
    await acceptResearchEvent(x.db, await buildCompanyResearchEvent({ sourceId: "remove", sourceRevision: 0, eventType: "upsert", urls: [{ slot: 1, url: "https://remove.example.com/" }] }), 101);
    const [remove] = await x.db.select().from(researchJobs).where(eq(researchJobs.sourceId, "remove"));
    await x.db.insert(researchPages).values({ pageId: "remove-page", jobId: remove.jobId, sourceId: "remove", canonicalUrl: "https://remove.example.com/", markdownKey: "remove.md", status: "ready", fetchedAt: 101 });
    x.objects.add("remove.md");
    await acceptResearchEvent(x.db, await buildCompanyResearchEvent({ sourceId: "remove", sourceRevision: 1, eventType: "delete", urls: [] }), 102);
    await purgeResearchData(x.db, x.bucket, 100 + 91 * 86_400, 1);
    expect(x.objects.has("remove.md")).toBe(false);
    expect(x.objects.has("clean.md")).toBe(true);
    expect((await x.db.select().from(researchJobs).where(eq(researchJobs.jobId, remove.jobId)))[0].phase).toBe("purged");
  });
});
