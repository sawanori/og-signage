import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db/index";
import { displayBundles, media, memberSpotlights, memberSpotlightSubmissions, users } from "@/db/schema";
import { seed } from "@/db/seed";
import type { AuthUser } from "@/lib/auth";
import { signageConfigSchema, type SignageConfig } from "@/lib/config-schema";
import { registerDevice } from "@/lib/services/devices";
import { listMedia, requestMediaDeletion } from "@/lib/services/media";
import { listSpotlightSubmissions } from "@/lib/services/spotlight-submissions";
import { createSpotlight, deleteSpotlight, updateSpotlight, type SpotlightRow } from "@/lib/services/spotlights";
import { handleDeviceRelay } from "@/worker/device-relay";
import { handlePublicSignageMedia } from "@/worker/public-signage-relay";
import { SpotlightBucket } from "../helpers/spotlight-bucket";
import { openTempDb } from "../helpers/temp-db";

const state = vi.hoisted(() => ({ db: null as unknown as Db, bucket: null as unknown as SpotlightBucket, session: null as unknown }));
vi.mock("@/lib/runtime", () => ({ getDb: () => state.db }));
vi.mock("@/lib/r2", async (original) => ({ ...await original<typeof import("@/lib/r2")>(), getMediaBucket: () => state.bucket }));
vi.mock("@/lib/build-id", () => ({ BUILD_ID: "registration-flow-test", BUILD_HEADER: "X-Signage-Build" }));
vi.mock("@/lib/auth", async (original) => {
  const actual = await original<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireRole: (role: import("@/lib/auth").Role) => actual.requireRole(role, { db: state.db, getSession: async () => state.session }),
    withRole: <C>(role: import("@/lib/auth").Role, handler: (request: Request, context: C, user: AuthUser) => Promise<Response>) =>
      actual.withRole(role, handler, () => ({ db: state.db, getSession: async () => state.session })),
  };
});

import * as submissionsEndpoint from "@/app/api/spotlight-submissions/route";
import { GET as getSubmissionImage } from "@/app/api/spotlight-submissions/[id]/images/[kind]/route";
import { GET as getPublicConfig } from "@/app/api/signage/config/route";
import { GET as getDeviceConfig } from "@/app/api/device/config/route";
import { approveSpotlightSubmissionAction, rejectSpotlightSubmissionAction } from "@/app/admin/_actions/spotlight-submissions";

const BASE = "https://signage.example.com";
const NOW = 1_790_000_000;
const PHOTO = new Uint8Array([255, 216, 255, 224, 1, 2, 3]);
const LOGO = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 4, 5]);
let db: Db;
let bucket: SpotlightBucket;
let close: () => void;
let staff: AuthUser;
let session: { userId: string; sessionVersion: number };
let deviceId: string;
let token: string;
let existing: SpotlightRow;

const input = () => ({
  requestKey: crypto.randomUUID(), companyName: "申請株式会社", personName: "申請 花子", personNameKana: "しんせい はなこ",
  role: "デザイナー", quote: "毎日が実験です", bio: "映像を作っています", tags: ["映像"], consent: true,
});

function post(data: ReturnType<typeof input>, withLogo = false) {
  const body = new FormData();
  body.set("data", JSON.stringify(data));
  body.set("photo", new Blob([PHOTO], { type: "image/jpeg" }), "photo.jpg");
  if (withLogo) body.set("logo", new Blob([LOGO], { type: "image/png" }), "logo.png");
  return submissionsEndpoint.POST(new Request(`${BASE}/api/spotlight-submissions`, {
    method: "POST", headers: { origin: BASE, "cf-connecting-ip": "192.0.2.1" }, body,
  }));
}

async function publicConfig(): Promise<SignageConfig> {
  const response = await getPublicConfig(new Request(`${BASE}/api/signage/config?device=${deviceId}`));
  expect(response.status).toBe(200);
  return signageConfigSchema.parse(await response.json());
}

async function deviceConfig(): Promise<SignageConfig> {
  const response = await getDeviceConfig(new Request(`${BASE}/api/device/config`, { headers: { authorization: `Bearer ${token}` } }));
  expect(response.status).toBe(200);
  return signageConfigSchema.parse(await response.json());
}

function publicImage(id: string) {
  const request = new Request(`${BASE}/api/signage/media/${encodeURIComponent(id)}?device=${deviceId}`);
  return handlePublicSignageMedia(request, new URL(request.url).pathname, { db, bucket, now: NOW });
}

function deviceImage(id: string) {
  const request = new Request(`${BASE}/api/device/media/${encodeURIComponent(id)}`, { headers: { authorization: `Bearer ${token}` } });
  return handleDeviceRelay(request, new URL(request.url).pathname, { db, bucket, now: NOW });
}

function privateImage(id: string, kind = "photo") {
  return getSubmissionImage(new Request(`${BASE}/api/spotlight-submissions/${id}/images/${kind}`), { params: Promise.resolve({ id, kind }) });
}

async function expectUnpublished(submissionId: string, expectedVersion: string) {
  for (const config of [await publicConfig(), await deviceConfig()]) {
    expect(config.version).toBe(expectedVersion);
    expect(config.spotlights?.map((item) => item.id)).toEqual([existing.id]);
    expect(JSON.stringify(config)).not.toContain("申請 花子");
  }
  expect(await listMedia(db)).toHaveLength(0);
  const [submission] = await db.select().from(memberSpotlightSubmissions).where(eq(memberSpotlightSubmissions.id, submissionId));
  for (const candidate of [submission.id, submission.photoFile!.r2Key, submission.photoFile!.sha256]) {
    expect((await publicImage(candidate))?.status).toBe(404);
    expect((await deviceImage(candidate))?.status).toBe(404);
  }
}

beforeEach(async () => {
  vi.spyOn(Date, "now").mockReturnValue(NOW * 1000);
  ({ db, close } = await openTempDb());
  state.db = db;
  bucket = state.bucket = new SpotlightBucket();
  state.session = null;
  await seed(db);
  const [user] = await db.insert(users).values({ email: "reviewer@example.com", name: "Staff", role: "staff" }).returning();
  staff = { id: user.id, email: user.email, name: user.name, role: user.role };
  session = { userId: user.id, sessionVersion: user.sessionVersion };
  await db.insert(displayBundles).values({ id: "bundle-registration", sha256: "a".repeat(64), size: 10, r2Key: "bundles/registration.zip", schemaVersion: 1, isCurrent: true });
  const issued = await registerDevice(db, { name: "受付", orientation: "landscape", resolutionWidth: 1920, resolutionHeight: 1080 }, BASE);
  deviceId = issued.deviceId;
  token = (JSON.parse(issued.content) as { deviceToken: string }).deviceToken;
  existing = await createSpotlight(db, staff, { companyName: "既存会社", personName: "既存 太郎", enabled: true });
});
afterEach(() => { vi.restoreAllMocks(); close(); });

describe("本人申請から既存サイネージ配信まで", () => {
  it("匿名受付は非公開で、Staff承認だけで素材と紹介が作られpublic/device configと画像に反映される", async () => {
    const before = await publicConfig();
    const data = input();
    const accepted = await post(data, true);
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ data: { accepted: true } });
    expect("GET" in submissionsEndpoint).toBe(false);
    const [pending] = await listSpotlightSubmissions(db, staff);
    await expectUnpublished(pending.id, before.version);
    expect((await privateImage(pending.id)).status).toBe(401);
    state.session = session;
    const protectedImage = await privateImage(pending.id);
    expect(protectedImage.status).toBe(200);
    expect(protectedImage.headers.get("cache-control")).toBe("private, no-store");
    expect(new Uint8Array(await protectedImage.arrayBuffer())).toEqual(PHOTO);

    const approved = await approveSpotlightSubmissionAction(pending.id, pending.revision);
    expect(approved.error).toBeUndefined();
    const id = approved.data!.spotlightId;
    const [row] = await db.select().from(memberSpotlights).where(eq(memberSpotlights.id, id!));
    expect(row).toMatchObject({ personName: data.personName, personNameKana: data.personNameKana, enabled: true });
    expect(await listMedia(db)).toHaveLength(2);
    expect(await listSpotlightSubmissions(db, staff)).toHaveLength(0);
    for (const config of [await publicConfig(), await deviceConfig()]) {
      expect(config.version).not.toBe(before.version);
      expect(config.spotlights).toHaveLength(2);
      const published = config.spotlights!.find((item) => item.id === id)!;
      expect(published).toMatchObject({ personName: data.personName, companyName: data.companyName, photo: { mediaId: row.photoMediaId }, logo: { mediaId: row.logoMediaId } });
      expect(published).not.toHaveProperty("personNameKana");
      expect(JSON.stringify(config)).not.toContain(data.personNameKana);
    }
    for (const response of [await publicImage(row.photoMediaId!), await deviceImage(row.photoMediaId!)]) {
      expect(response?.status).toBe(200);
      expect(new Uint8Array(await response!.arrayBuffer())).toEqual(PHOTO);
    }
    state.session = null;
    expect((await post(data, true)).status).toBe(202);
    expect(await db.select().from(memberSpotlightSubmissions)).toHaveLength(1);
    expect(await db.select().from(memberSpotlights)).toHaveLength(2);
    expect(await db.select().from(media)).toHaveLength(2);
  });

  it("画像保存中断でreceivingのまま残った画像も公開経路・通常素材一覧へ出さない", async () => {
    const before = await publicConfig();
    const put = bucket.put.bind(bucket);
    vi.spyOn(bucket, "put").mockImplementation(async (key, bytes, options) => {
      if (key.endsWith("/logo")) throw new Error("R2 unavailable");
      return put(key, bytes, options);
    });
    expect((await post(input(), true)).status).toBe(503);
    const [receiving] = await db.select().from(memberSpotlightSubmissions);
    expect(receiving.status).toBe("receiving");
    expect(bucket.objects.has(receiving.photoFile!.r2Key)).toBe(true);
    await expectUnpublished(receiving.id, before.version);
    state.session = session;
    expect((await privateImage(receiving.id)).status).toBe(404);
  });

  it("却下後の同一POSTを受けても公開されず、通常素材も作らない", async () => {
    const before = await publicConfig();
    const data = input();
    expect((await post(data)).status).toBe(202);
    const [pending] = await listSpotlightSubmissions(db, staff);
    state.session = session;
    expect(await rejectSpotlightSubmissionAction(pending.id, pending.revision)).toEqual({ data: null });
    state.session = null;
    expect((await post(data)).status).toBe(202);
    await expectUnpublished(pending.id, before.version);
    state.session = session;
    expect((await privateImage(pending.id)).status).toBe(404);
    expect(await listSpotlightSubmissions(db, staff)).toHaveLength(0);
  });

  it("承認後も既存編集・表示切替・削除と素材参照保護を適用し、既存掲載メンバーを維持する", async () => {
    expect((await post(input())).status).toBe(202);
    const [pending] = await listSpotlightSubmissions(db, staff);
    state.session = session;
    const approved = await approveSpotlightSubmissionAction(pending.id, pending.revision);
    const [row] = await db.select().from(memberSpotlights).where(eq(memberSpotlights.id, approved.data!.spotlightId!));
    await expect(requestMediaDeletion(db, row.photoMediaId!, NOW)).rejects.toMatchObject({ code: "in_use" });
    const hidden = await updateSpotlight(db, staff, row.id, { ...row, personName: "掲載後の修正", enabled: false });
    expect((await publicConfig()).spotlights?.map((item) => item.id)).toEqual([existing.id]);
    expect((await publicImage(row.photoMediaId!))?.status).toBe(404);
    await updateSpotlight(db, staff, row.id, { ...hidden, enabled: true });
    expect((await publicConfig()).spotlights?.find((item) => item.id === row.id)?.personName).toBe("掲載後の修正");
    await deleteSpotlight(db, staff, row.id);
    expect(await approveSpotlightSubmissionAction(pending.id, pending.revision)).toEqual({ data: { spotlightId: null } });
    expect((await publicConfig()).spotlights?.map((item) => item.id)).toEqual([existing.id]);
    await requestMediaDeletion(db, row.photoMediaId!, NOW);
    expect(await listMedia(db)).toHaveLength(0);
  });
});
