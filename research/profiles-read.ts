/**
 * 企業データの読み取り（2026-10-02 ユーザー指示）。メインの管理画面（閲覧を許可したアカウントだけ）から
 * Service Binding で呼ばれる。分析 Worker は workers_dev:false・routes:[] なので、外から直接は届かない。
 * 受付（handleIntake）とは分け、受付には今までどおり読み取りの入口を持たせない。
 */
import { eq } from "drizzle-orm";
import type { ResearchDb } from "./db/client";
import { researchJobs, researchProfiles, researchSubjects } from "./db/schema";

export type ResearchProfileListItem = {
  sourceId: string;
  lastSuccessfulCrawlAt: number | null;
  job: { status: string; phase: string; lastErrorCode: string | null; updatedAt: number; urls: { slot: number; url: string }[] } | null;
  profile: { payload: Record<string, unknown>; extractedAt: number; createdAt: number } | null;
};

/** URL を登録しているメンバー（active）だけ。解除・削除済みは返さない */
export async function listResearchProfiles(db: ResearchDb): Promise<ResearchProfileListItem[]> {
  const subjects = await db.select().from(researchSubjects).where(eq(researchSubjects.status, "active"));
  return Promise.all(subjects.map(async (subject) => {
    const [job] = subject.currentJobId ? await db.select().from(researchJobs).where(eq(researchJobs.jobId, subject.currentJobId)) : [];
    const [profile] = subject.currentProfileId ? await db.select().from(researchProfiles).where(eq(researchProfiles.profileId, subject.currentProfileId)) : [];
    return {
      sourceId: subject.sourceId,
      lastSuccessfulCrawlAt: subject.lastSuccessfulCrawlAt,
      job: job ? {
        status: job.status, phase: job.phase,
        // 成功した処理にも前回の失敗の記録が残るので、成功時は出さない
        lastErrorCode: job.status === "succeeded" ? null : job.lastErrorCode,
        updatedAt: job.updatedAt, urls: job.urls,
      } : null,
      profile: profile ? { payload: profile.payload, extractedAt: profile.extractedAt, createdAt: profile.createdAt } : null,
    };
  }));
}

export async function handleProfileRead(request: Request, db: ResearchDb): Promise<Response> {
  if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } });
  return Response.json({ data: await listResearchProfiles(db) }, { headers: { "cache-control": "no-store" } });
}
