/**
 * Web 公開のサイネージ（/signage）のデータと画像の中継。ログイン不要。
 * GET /api/signage/config と worker/public-signage-relay.ts。DB は一時 libSQL ファイル、R2 はメモリ上の偽物。
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../db/index";
import { devices, displayBundles, events, media, playlistItems, videoPlaybackSettings } from "../../db/schema";
import { SEED_PLAYLIST_ID, seed } from "../../db/seed";
import { signageConfigSchema, type SignageConfig } from "../../lib/config-schema";
import type { MediaBucket, R2ObjectWithBody } from "../../lib/r2";
import { registerDevice } from "../../lib/services/devices";
import { handlePublicSignageMedia } from "../../worker/public-signage-relay";
import { openTempDb } from "../helpers/temp-db";

const state = vi.hoisted(() => ({ db: null as unknown as Db }));
vi.mock("../../lib/runtime", () => ({ getDb: () => state.db }));

const { GET: getPublicConfig } = await import("../../app/api/signage/config/route");

class FakeBucket implements Pick<MediaBucket, "get" | "head"> {
  objects = new Map<string, Uint8Array>();

  async head(key: string) {
    const data = this.objects.get(key);
    return data ? { size: data.length, httpEtag: `"etag-${key}"` } : null;
  }

  async get(key: string): Promise<R2ObjectWithBody | null> {
    const data = this.objects.get(key);
    if (!data) return null;
    return {
      size: data.length,
      httpEtag: `"etag-${key}"`,
      body: new Response(new Uint8Array(data)).body!,
      arrayBuffer: async () => data.slice().buffer,
    };
  }
}

const BASE = "https://signage.example.com";
const sha = (n: number) => n.toString(16).padStart(64, "0");
const IMAGE_BYTES = new Uint8Array([1, 2, 3, 4, 5]);

let close: () => void;
let db: Db;
let bucket: FakeBucket;
let deviceA: string;
let deviceB: string;

async function insertMedia(id: string, type: "image" | "video", n: number) {
  const r2Key = `media/${id}/original`;
  bucket.objects.set(r2Key, IMAGE_BYTES);
  await db.insert(media).values({
    id,
    name: id,
    type,
    r2Key,
    mimeType: type === "image" ? "image/webp" : "video/mp4",
    fileSize: IMAGE_BYTES.length,
    sha256: sha(n),
    durationSeconds: type === "video" ? 15 : null,
    playable: type === "video",
  });
}

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
  bucket = new FakeBucket();
  await seed(db);

  await insertMedia("img_event", "image", 1);
  await insertMedia("img_unused", "image", 2);
  await insertMedia("img_draft", "image", 3);
  await insertMedia("vid_a", "video", 4);
  await db.insert(playlistItems).values({ playlistId: SEED_PLAYLIST_ID, mediaId: "vid_a", position: 0 });
  await db.insert(displayBundles).values({ id: "b1", sha256: sha(100), size: 10, r2Key: "bundles/b1.zip", schemaVersion: 1, isCurrent: true });

  const now = Math.floor(Date.now() / 1000);
  await db.insert(events).values([
    { id: "ev_pub", title: "映画会", startAt: now + 3600, categoryId: "cat_movie", imageMediaId: "img_event", status: "published" },
    { id: "ev_draft", title: "下書き", startAt: now + 3600, imageMediaId: "img_draft", status: "draft" },
  ]);

  deviceA = (await registerDevice(db, { name: "A", orientation: "portrait", resolutionWidth: 1080, resolutionHeight: 1920 }, BASE)).deviceId;
  deviceB = (await registerDevice(db, { name: "B", orientation: "landscape", resolutionWidth: 1920, resolutionHeight: 1080 }, BASE)).deviceId;
  // 「最初に登録した端末」を確実に A にする（同じ秒に登録されるため）
  await db.update(devices).set({ createdAt: 1 }).where(eq(devices.id, deviceA));
  await db.update(videoPlaybackSettings).set({ playlistId: SEED_PLAYLIST_ID }).where(eq(videoPlaybackSettings.deviceId, deviceA));
});

afterEach(() => close());

async function fetchConfig(query = ""): Promise<Response> {
  return getPublicConfig(new Request(`${BASE}/api/signage/config${query}`));
}

function relay(path: string): Promise<Response | null> {
  const request = new Request(`${BASE}${path}`);
  return handlePublicSignageMedia(request, new URL(request.url).pathname, { db, bucket: bucket as unknown as MediaBucket });
}

describe("GET /api/signage/config（ログイン不要）", () => {
  it("最初に登録した端末の表示データを返し、動画の一覧とテスト表示の要求は外す", async () => {
    const res = await fetchConfig();
    expect(res.status).toBe(200);
    const config = signageConfigSchema.parse(await res.json()) as SignageConfig;
    expect(config.device.orientation).toBe("portrait");
    expect(config.events.map((e) => e.id)).toEqual(["ev_pub"]);
    expect(config.playlist).toEqual([]);
    expect(config.commands.testPlayRequestedAt).toBeNull();
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("?device で端末を選べる", async () => {
    const res = await fetchConfig(`?device=${deviceB}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as SignageConfig).device.orientation).toBe("landscape");
  });

  it("存在しない端末や、端末が 1 台も無いときは 404", async () => {
    expect((await fetchConfig("?device=nope")).status).toBe(404);
    await db.delete(videoPlaybackSettings);
    await db.delete(devices);
    expect((await fetchConfig()).status).toBe(404);
  });

  it("表示バンドルが未公開なら 503", async () => {
    await db.delete(displayBundles);
    expect((await fetchConfig()).status).toBe(503);
  });
});

describe("GET /api/signage/media/[mediaId]（公開中の画像だけ）", () => {
  it("公開中のイベントの画像は返す", async () => {
    const res = await relay(`/api/signage/media/img_event?device=${deviceA}`);
    expect(res?.status).toBe(200);
    expect(new Uint8Array(await res!.arrayBuffer())).toEqual(IMAGE_BYTES);
  });

  it("アップロードしただけの画像・下書きイベントの画像・動画は 404", async () => {
    for (const id of ["img_unused", "img_draft", "vid_a", "nope"]) {
      expect((await relay(`/api/signage/media/${id}`))?.status, id).toBe(404);
    }
  });

  it("イベントを下書きに戻すと、その画像は返さなくなる", async () => {
    await db.update(events).set({ status: "draft" }).where(eq(events.id, "ev_pub"));
    expect((await relay("/api/signage/media/img_event"))?.status).toBe(404);
  });

  it("別の経路は扱わない", async () => {
    expect(await relay("/api/media/img_event/file")).toBeNull();
  });
});
