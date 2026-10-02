import { afterEach, describe, expect, it } from "vitest";
import { handleIntake } from "../../research/intake";
import { handleProfileRead, listResearchProfiles } from "../../research/profiles-read";
import { researchJobs, researchProfiles, researchSubjects } from "../../research/db/schema";
import { openTestResearchDatabase } from "./db-helper";

const all: Awaited<ReturnType<typeof openTestResearchDatabase>>[] = [];
afterEach(() => { for (const connection of all.splice(0)) connection.close(); });

async function seed() {
  const connection = await openTestResearchDatabase(); all.push(connection);
  const { db } = connection;
  await db.insert(researchSubjects).values([
    { sourceId: "member-a", sourceRevision: 1, urlFingerprint: "fp", status: "active", currentJobId: "job-a", currentProfileId: "profile-a", lastSuccessfulCrawlAt: 100 },
    { sourceId: "member-b", sourceRevision: 1, urlFingerprint: "fp", status: "active", currentJobId: "job-b" },
    { sourceId: "member-gone", sourceRevision: 2, urlFingerprint: "fp", status: "revoked" },
  ]);
  await db.insert(researchJobs).values([
    // 成功した処理に前回の失敗の記録が残っていても、画面には出さない
    { jobId: "job-a", sourceId: "member-a", generation: 1, urlFingerprint: "fp", urls: [{ slot: 1, url: "https://a.example/" }], status: "succeeded", phase: "complete", lastErrorCode: "private_model_output", updatedAt: 200 },
    { jobId: "job-b", sourceId: "member-b", generation: 1, urlFingerprint: "fp", urls: [{ slot: 1, url: "https://b.example/" }], status: "failed", phase: "complete", lastErrorCode: "no_eligible_pages", updatedAt: 300 },
  ]);
  await db.insert(researchProfiles).values({ profileId: "profile-a", sourceId: "member-a", jobId: "job-a", generation: 1, contentHash: "h", schemaVersion: 1, model: "m", promptVersion: "p", payload: { company: { name: null } }, extractedAt: 150, createdAt: 160 });
  return connection;
}

describe("企業データの読み取り（管理画面の企業データ用）", () => {
  it("URL を登録中のメンバーだけを、処理の状態と現在の企業データと一緒に返す", async () => {
    const { db } = await seed();
    const items = await listResearchProfiles(db);
    expect(items.map((item) => item.sourceId).sort()).toEqual(["member-a", "member-b"]);
    expect(items.find((item) => item.sourceId === "member-a")).toEqual({
      sourceId: "member-a", lastSuccessfulCrawlAt: 100,
      job: { status: "succeeded", phase: "complete", lastErrorCode: null, updatedAt: 200, urls: [{ slot: 1, url: "https://a.example/" }] },
      profile: { payload: { company: { name: null } }, extractedAt: 150, createdAt: 160 },
    });
    expect(items.find((item) => item.sourceId === "member-b")).toMatchObject({ job: { status: "failed", lastErrorCode: "no_eligible_pages" }, profile: null });
  });

  it("GET だけを受け、キャッシュさせない。受付（handleIntake）には今までどおり読み取りの入口が無い", async () => {
    const { db } = await seed();
    const response = await handleProfileRead(new Request("https://research.internal/internal/profiles"), db);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect((await response.json()).data).toHaveLength(2);
    expect((await handleProfileRead(new Request("https://research.internal/internal/profiles", { method: "POST", body: "{}" }), db)).status).toBe(405);
    expect((await handleIntake(new Request("https://research.internal/internal/profiles"), db)).status).toBe(404);
  });
});
