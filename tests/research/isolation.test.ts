import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../db/index";
import { companyResearchOutbox, displayBundles, memberSpotlights } from "../../db/schema";
import { seed } from "../../db/seed";
import type { AuthUser } from "../../lib/auth";
import { collectMediaRefs, signageConfigSchema } from "../../lib/config-schema";
import { registerDevice } from "../../lib/services/devices";
import { createSpotlight, type SpotlightRow } from "../../lib/services/spotlights";
import { handleIntake } from "../../research/intake";
import { researchEvents, researchJobs, researchPages, researchProfiles, researchSubjects } from "../../research/db/schema";
import { dispatchCompanyResearchEvents } from "../../worker/company-research-dispatch";
import { handleDeviceRelay } from "../../worker/device-relay";
import { handlePublicSignageMedia } from "../../worker/public-signage-relay";
import { SpotlightBucket } from "../helpers/spotlight-bucket";
import { openTempDb } from "../helpers/temp-db";
import { openTestResearchDatabase } from "./db-helper";

const state = vi.hoisted(() => ({ db: null as unknown as Db }));
vi.mock("../../lib/runtime", () => ({ getDb: () => state.db }));
vi.mock("../../lib/build-id", () => ({ BUILD_ID: "research-isolation-test", BUILD_HEADER: "X-Signage-Build" }));

import { GET as getPublicConfig } from "../../app/api/signage/config/route";
import { GET as getDeviceConfig } from "../../app/api/device/config/route";

const NOW = 1_790_000_000;
const BASE = "https://signage.example.com";
const MARKER = "research-only-content-do-not-publish";
const SECOND_URL = "https://internal-only-second.example.com/services";
const staff: AuthUser = { id: "staff", name: "Staff", email: "staff@example.com", role: "staff" };
let db: Db;
let close: () => void;
let research: Awaited<ReturnType<typeof openTestResearchDatabase>>;
let bucket: SpotlightBucket;
let deviceId: string;
let deviceToken: string;
let spotlight: SpotlightRow;

beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
  ({ db, close } = await openTempDb());
  state.db = db;
  research = await openTestResearchDatabase();
  bucket = new SpotlightBucket();
  await seed(db);
  await db.insert(displayBundles).values({ id: "isolation-bundle", sha256: "a".repeat(64), size: 10, r2Key: "bundles/isolation.zip", schemaVersion: 1, isCurrent: true });
  const issued = await registerDevice(db, { name: "Isolation", orientation: "landscape", resolutionWidth: 1920, resolutionHeight: 1080 }, BASE);
  deviceId = issued.deviceId;
  deviceToken = (JSON.parse(issued.content) as { deviceToken: string }).deviceToken;
  spotlight = await createSpotlight(db, staff, {
    companyName: "掲載用会社", personName: "登録 太郎", contactEmail: "registration-private@example.com",
    websiteUrl: "https://first.example.com/", websiteUrl2: SECOND_URL,
    bio: "手入力の紹介文", quote: "手入力のひとこと", tags: ["映像"], enabled: true,
  });
});
afterEach(() => { vi.restoreAllMocks(); research.close(); close(); });

async function configs() {
  const publicResponse = await getPublicConfig(new Request(`${BASE}/api/signage/config?device=${deviceId}`));
  const deviceResponse = await getDeviceConfig(new Request(`${BASE}/api/device/config`, { headers: { authorization: `Bearer ${deviceToken}` } }));
  expect(publicResponse.status).toBe(200);
  expect(deviceResponse.status).toBe(200);
  const publicBody = await publicResponse.text();
  const deviceBody = await deviceResponse.text();
  for (const body of [publicBody, deviceBody]) {
    expect(body).not.toContain(MARKER);
    expect(body).not.toContain(SECOND_URL);
    expect(body).not.toMatch(/websiteUrl2|researchProfiles|researchPages|markdownKey|rawKey|currentProfileId|registration-private/);
    expect(signageConfigSchema.parse(JSON.parse(body)).spotlights).toEqual([{
      id: spotlight.id, companyName: "掲載用会社", personName: "登録 太郎", role: null,
      quote: "手入力のひとこと", bio: "手入力の紹介文", tags: ["映像"],
      websiteUrl: "https://first.example.com/", photo: null, logo: null,
    }]);
  }
  return { publicBody, deviceBody, publicEtag: publicResponse.headers.get("etag"), deviceEtag: deviceResponse.headers.get("etag") };
}

async function dispatch() {
  return dispatchCompanyResearchEvents(db, {
    fetch: (input, init) => handleIntake(new Request(input, init), research.db, NOW),
  }, NOW);
}

async function storePrivateResearch() {
  expect(await dispatch()).toEqual({ delivered: 1, retried: 0, blocked: 0, unavailable: false });
  const [job] = await research.db.select().from(researchJobs);
  const pageId = "private-research-page";
  const profileId = "private-research-profile";
  const markdownKey = `research/${spotlight.id}/${job.jobId}/source.md`;
  const rawKey = `research/${spotlight.id}/${job.jobId}/source.html`;
  await research.db.insert(researchPages).values({ pageId, jobId: job.jobId, sourceId: spotlight.id, canonicalUrl: SECOND_URL, contentHash: "b".repeat(64), markdownKey, rawKey, title: MARKER, status: "ready", fetchedAt: NOW });
  await research.db.insert(researchProfiles).values({ profileId, jobId: job.jobId, sourceId: spotlight.id, generation: job.generation, contentHash: "b".repeat(64), schemaVersion: 1, model: "muse-spark-1.3-contributor", promptVersion: "isolation-test", payload: { company: MARKER, strengths: [MARKER], sourceUrl: SECOND_URL }, extractedAt: NOW });
  await research.db.update(researchSubjects).set({ currentProfileId: profileId }).where(eq(researchSubjects.sourceId, spotlight.id));
  return { pageId, profileId, markdownKey, rawKey };
}

describe("Mainと非公開企業研究の分離", () => {
  it("通常保存のイベントを別DBへ実配送し、研究データの作成・更新だけでは公開/端末本文と版を変えない", async () => {
    const before = await configs();
    expect(before.deviceEtag).not.toBeNull();
    const { profileId } = await storePrivateResearch();
    expect(await configs()).toEqual(before);
    await research.db.update(researchProfiles).set({ payload: { company: `${MARKER}-updated` } }).where(eq(researchProfiles.profileId, profileId));
    expect(await configs()).toEqual(before);
    expect((await db.select().from(memberSpotlights).where(eq(memberSpotlights.id, spotlight.id)))[0]).toEqual(spotlight);
    expect((await db.select().from(companyResearchOutbox))[0]).toMatchObject({ status: "delivered", sourceId: spotlight.id });
    expect(await research.db.select().from(researchEvents)).toHaveLength(1);
    const serializedJobs = JSON.stringify(await research.db.select().from(researchJobs));
    expect(serializedJobs).toContain(SECOND_URL);
    for (const privateValue of [spotlight.personName, spotlight.contactEmail, spotlight.bio, spotlight.quote]) expect(serializedJobs).not.toContain(privateValue!);
    const mainTables = await db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table'`);
    const researchTables = await research.db.all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table'`);
    expect(mainTables.map(({ name }) => name)).not.toContain("research_profiles");
    expect(researchTables.map(({ name }) => name)).not.toContain("member_spotlights");
  });

  it("研究page/profile IDとR2 keyは公開/端末の素材経路から取得できずPi素材一覧にも載らない", async () => {
    const privateIds = Object.values(await storePrivateResearch());
    // R2に同じkeyが存在しても、掲載mediaとの関連がなければ配信してはいけない。
    for (const id of privateIds) bucket.objects.set(id, new TextEncoder().encode(MARKER));
    const read = vi.spyOn(bucket, "get");
    for (const id of privateIds) {
      const publicRequest = new Request(`${BASE}/api/signage/media/${encodeURIComponent(id)}?device=${deviceId}`);
      const deviceRequest = new Request(`${BASE}/api/device/media/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${deviceToken}` } });
      const responses = [
        await handlePublicSignageMedia(publicRequest, new URL(publicRequest.url).pathname, { db, bucket, now: NOW }),
        await handleDeviceRelay(deviceRequest, new URL(deviceRequest.url).pathname, { db, bucket, now: NOW }),
      ];
      for (const response of responses) {
        expect(response?.status).toBe(404);
        expect(await response!.text()).not.toContain(MARKER);
      }
    }
    expect(read).not.toHaveBeenCalled();
    const config = signageConfigSchema.parse(JSON.parse((await configs()).deviceBody));
    expect(collectMediaRefs(config)).toEqual([]);
  });

  it("非公開受付は分析結果を返すGETを持たない", async () => {
    await storePrivateResearch();
    for (const path of ["/", "/internal/profiles", `/internal/profiles/${spotlight.id}`]) {
      const response = await handleIntake(new Request(`https://research.internal${path}`), research.db, NOW);
      expect(response.status).toBe(404);
      expect(await response.text()).not.toContain(MARKER);
    }
    const get = await handleIntake(new Request("https://research.internal/internal/sources"), research.db, NOW);
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    expect(await get.text()).toBe("");
  });
});
