import { and, asc, eq, inArray, isNotNull, lte, notInArray, or, sql } from "drizzle-orm";
import { researchWrite, type ResearchDb } from "./db/client";
import { researchJobs, researchPages, researchProfiles, researchSubjects, researchNow } from "./db/schema";
import type { ResearchBucket } from "./env";

/** Run even while research is paused; failed object deletes remain tracked for retry. */
export async function purgeResearchData(db: ResearchDb, bucket: ResearchBucket, now = researchNow(), limit = 50) {
  const result = { rawDeleted: 0, pagesDeleted: 0, profilesDeleted: 0, failed: 0 };
  const raw = await db.select().from(researchPages).where(and(isNotNull(researchPages.rawKey), lte(researchPages.rawExpiresAt, now))).limit(limit);
  for (const page of raw) {
    try {
      await bucket.delete(page.rawKey!);
      await db.update(researchPages).set({ rawKey: null, rawExpiresAt: null }).where(and(eq(researchPages.pageId, page.pageId), eq(researchPages.rawKey, page.rawKey!)));
      result.rawDeleted++;
    } catch { result.failed++; }
  }
  const protectedProfiles = db.select({ jobId: researchProfiles.jobId }).from(researchProfiles).innerJoin(researchSubjects, eq(researchSubjects.currentProfileId, researchProfiles.profileId));
  const current = db.select({ jobId: researchSubjects.currentJobId }).from(researchSubjects).where(and(eq(researchSubjects.status, "active"), isNotNull(researchSubjects.currentJobId)));
  const candidates = await db.select().from(researchJobs).where(and(sql`${researchJobs.phase} != 'purged'`, notInArray(researchJobs.jobId, protectedProfiles), notInArray(researchJobs.jobId, current), or(lte(researchJobs.purgeAfter, now), and(inArray(researchJobs.status, ["succeeded", "failed", "superseded"]), lte(researchJobs.updatedAt, now - 90 * 86_400))))).orderBy(asc(sql`coalesce(${researchJobs.purgeAfter}, ${researchJobs.updatedAt} + ${90 * 86_400})`), asc(researchJobs.jobId)).limit(limit);
  let remaining = limit;
  for (const job of candidates) {
    const pages = await db.select().from(researchPages).where(eq(researchPages.jobId, job.jobId)).limit(remaining);
    for (const page of pages) {
      try {
        const keys = [page.rawKey, page.markdownKey].filter((key): key is string => key !== null);
        if (keys.length) await bucket.delete(keys);
        await db.delete(researchPages).where(eq(researchPages.pageId, page.pageId));
        result.pagesDeleted++; remaining--;
      } catch { result.failed++; }
    }
    const [{ total }] = await db.select({ total: sql<number>`count(*)` }).from(researchPages).where(eq(researchPages.jobId, job.jobId));
    if (total === 0) {
      await researchWrite(db, async (tx) => {
        const [live] = await tx.select().from(researchSubjects).where(eq(researchSubjects.currentJobId, job.jobId));
        const [profile] = await tx.select({ id: researchProfiles.profileId }).from(researchProfiles).innerJoin(researchSubjects, eq(researchSubjects.currentProfileId, researchProfiles.profileId)).where(eq(researchProfiles.jobId, job.jobId));
        if (live || profile) return;
        result.profilesDeleted += (await tx.delete(researchProfiles).where(eq(researchProfiles.jobId, job.jobId)).returning()).length;
        // Keep usage references and minimal execution history, but remove crawled URLs/progress.
        await tx.update(researchJobs).set({ urls: [], progress: {}, purgeAfter: null, phase: "purged" }).where(eq(researchJobs.jobId, job.jobId));
      });
    }
    if (remaining <= 0) break;
  }
  const dueSubjects = await db.select().from(researchSubjects).where(and(inArray(researchSubjects.status, ["revoked", "deleted"]), lte(researchSubjects.purgeAfter, now))).limit(limit);
  for (const subject of dueSubjects) {
    const [{ total }] = await db.select({ total: sql<number>`count(*)` }).from(researchPages).where(eq(researchPages.sourceId, subject.sourceId));
    const [{ profiles }] = await db.select({ profiles: sql<number>`count(*)` }).from(researchProfiles).where(eq(researchProfiles.sourceId, subject.sourceId));
    const [{ jobs }] = await db.select({ jobs: sql<number>`count(*)` }).from(researchJobs).where(and(eq(researchJobs.sourceId, subject.sourceId), sql`${researchJobs.phase} != 'purged'`));
    if (total === 0 && profiles === 0 && jobs === 0) await db.update(researchSubjects).set({ purgedAt: now, purgeAfter: null }).where(and(eq(researchSubjects.sourceId, subject.sourceId), eq(researchSubjects.sourceRevision, subject.sourceRevision), inArray(researchSubjects.status, ["revoked", "deleted"])));
  }
  return result;
}
