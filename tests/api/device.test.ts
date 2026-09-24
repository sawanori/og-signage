/**
 * 端末用 API（task_012）。GET /api/device/config、media・bundles の中継（worker/device-relay.ts）、
 * heartbeat・logs・media-failures。DB は一時 libSQL ファイル、R2 はメモリ上の偽物。
 */
import { and, eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../db/index";
import {
  deviceLogs,
  devices,
  displayBundles,
  events,
  media,
  mediaFailures,
  nowSeconds,
  playlistItems,
  playlists,
  videoPlaybackSettings,
  weatherCache,
} from "../../db/schema";
import { SEED_PLAYLIST_ID, seed } from "../../db/seed";
import { buildDeviceConfig, canonicalJson } from "../../lib/config-builder";
import { signageConfigSchema, type SignageConfig } from "../../lib/config-schema";
import { startOfTokyoDay } from "../../lib/dates";
import type { MediaBucket, R2ObjectWithBody, R2Range } from "../../lib/r2";
import { registerDevice } from "../../lib/services/devices";
import { handleDeviceRelay } from "../../worker/device-relay";
import { openTempDb } from "../helpers/temp-db";

const state = vi.hoisted(() => ({ db: null as unknown as Db }));
vi.mock("../../lib/runtime", () => ({ getDb: () => state.db }));

const { GET: getConfig } = await import("../../app/api/device/config/route");
const { POST: postHeartbeat } = await import("../../app/api/device/heartbeat/route");
const { POST: postLogs } = await import("../../app/api/device/logs/route");
const { POST: postMediaFailures } = await import("../../app/api/device/media-failures/route");

// ---------------------------------------------------------------- R2 の偽物（get / head だけ）

class FakeBucket implements Pick<MediaBucket, "get" | "head"> {
  objects = new Map<string, Uint8Array>();

  async head(key: string) {
    const data = this.objects.get(key);
    return data ? { size: data.length, httpEtag: `"etag-${key}"` } : null;
  }

  async get(key: string, options?: { range?: R2Range }): Promise<R2ObjectWithBody | null> {
    const data = this.objects.get(key);
    if (!data) return null;
    let slice = data;
    const range = options?.range;
    if (range && "offset" in range) {
      if (range.offset >= data.length) throw new Error("InvalidRange");
      slice = data.slice(range.offset, range.offset + range.length);
    }
    return {
      size: data.length,
      httpEtag: `"etag-${key}"`,
      body: new Response(new Uint8Array(slice)).body!,
      arrayBuffer: async () => slice.slice().buffer,
    };
  }
}

// ---------------------------------------------------------------- 準備

const sha = (n: number) => n.toString(16).padStart(64, "0");
const BASE = "https://signage.example.com";

let close: () => void;
let db: Db;
let bucket: FakeBucket;
let tokenA: string;
let tokenB: string;
let deviceA: string;
let deviceB: string;

const IMAGE_BYTES = new Uint8Array(Array.from({ length: 100 }, (_, i) => i));
const VIDEO_BYTES = new Uint8Array(Array.from({ length: 1000 }, (_, i) => i % 251));
const VIDEO_B_BYTES = new Uint8Array(500).fill(7);
const BUNDLE_BYTES = new Uint8Array(300).fill(9);

async function insertMedia(id: string, type: "image" | "video", bytes: Uint8Array, n: number, extra: Partial<typeof media.$inferInsert> = {}) {
  const r2Key = `media/${id}/original`;
  bucket.objects.set(r2Key, bytes);
  await db.insert(media).values({
    id,
    name: id,
    type,
    r2Key,
    mimeType: type === "image" ? "image/png" : "video/mp4",
    fileSize: bytes.length,
    sha256: sha(n),
    durationSeconds: type === "video" ? 15 : null,
    playable: type === "video",
    ...extra,
  });
}

function tokenOf(content: string): string {
  return (JSON.parse(content) as { deviceToken: string }).deviceToken;
}

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
  bucket = new FakeBucket();
  await seed(db);

  await insertMedia("img_event", "image", IMAGE_BYTES, 1);
  await insertMedia("vid_a", "video", VIDEO_BYTES, 2);
  await insertMedia("vid_b", "video", VIDEO_B_BYTES, 3);
  await insertMedia("vid_unplayable", "video", VIDEO_BYTES, 4, { playable: false });
  await db.insert(playlistItems).values([
    { playlistId: SEED_PLAYLIST_ID, mediaId: "vid_a", position: 0 },
    { playlistId: SEED_PLAYLIST_ID, mediaId: "vid_unplayable", position: 1 },
  ]);
  await db.insert(playlists).values({ id: "playlist_b", name: "B 用" });
  await db.insert(playlistItems).values({ playlistId: "playlist_b", mediaId: "vid_b", position: 0 });

  bucket.objects.set("bundles/b1.zip", BUNDLE_BYTES);
  await db.insert(displayBundles).values({ id: "b1", sha256: sha(100), size: BUNDLE_BYTES.length, r2Key: "bundles/b1.zip", schemaVersion: 1, isCurrent: true });

  const now = nowSeconds();
  await db.insert(events).values([
    { id: "ev_pub", title: "映画会", startAt: now + 3600, categoryId: "cat_movie", imageMediaId: "img_event", status: "published" },
    { id: "ev_draft", title: "下書き", startAt: now + 3600, status: "draft" },
    { id: "ev_far", title: "遠い先", startAt: now + 60 * 24 * 3600, status: "published" },
    { id: "ev_old", title: "終わった", startAt: now - 10 * 24 * 3600, status: "published" },
  ]);

  const a = await registerDevice(db, { name: "A", orientation: "portrait", resolutionWidth: 1080, resolutionHeight: 1920 }, BASE);
  const b = await registerDevice(db, { name: "B", orientation: "landscape", resolutionWidth: 1920, resolutionHeight: 1080 }, BASE);
  deviceA = a.deviceId;
  deviceB = b.deviceId;
  tokenA = tokenOf(a.content);
  tokenB = tokenOf(b.content);
  await db.update(videoPlaybackSettings).set({ playlistId: "playlist_b" }).where(eq(videoPlaybackSettings.deviceId, deviceB));
});

afterEach(() => close());

function req(path: string, init: RequestInit & { token?: string | null } = {}): Request {
  const { token, headers, ...rest } = init;
  const h = new Headers(headers);
  if (token) h.set("authorization", `Bearer ${token}`);
  return new Request(`${BASE}${path}`, { ...rest, headers: h });
}

function post(path: string, body: unknown, token: string | null = tokenA): Request {
  return req(path, { method: "POST", token, body: JSON.stringify(body), headers: { "content-type": "application/json" } });
}

function relay(path: string, init: RequestInit & { token?: string | null } = {}): Promise<Response | null> {
  const request = req(path, { token: tokenA, ...init });
  return handleDeviceRelay(request, new URL(request.url).pathname, { db, bucket: bucket as unknown as MediaBucket });
}

async function fetchConfig(token = tokenA): Promise<SignageConfig> {
  const res = await getConfig(req("/api/device/config", { token }));
  expect(res.status).toBe(200);
  return (await res.json()) as SignageConfig;
}

// ---------------------------------------------------------------- 認証

describe("認証", () => {
  const BAD = "A".repeat(43);

  it.each([
    ["ヘッダーなし", null],
    ["形式違い", "short"],
    ["登録されていないトークン", BAD],
  ])("%s は 401（config・heartbeat・logs・media-failures・中継）", async (_label, token) => {
    expect((await getConfig(req("/api/device/config", { token }))).status).toBe(401);
    expect((await postHeartbeat(post("/api/device/heartbeat", {}, token))).status).toBe(401);
    expect((await postLogs(post("/api/device/logs", {}, token))).status).toBe(401);
    expect((await postMediaFailures(post("/api/device/media-failures", {}, token))).status).toBe(401);
    expect((await relay("/api/device/media/vid_a", { token }))!.status).toBe(401);
    expect((await relay("/api/device/bundles/b1", { token }))!.status).toBe(401);
  });

  it("401 の本文にトークンを含めない", async () => {
    const res = await getConfig(req("/api/device/config", { token: BAD }));
    expect(await res.text()).not.toContain(BAD);
  });
});

// ---------------------------------------------------------------- config

describe("GET /api/device/config", () => {
  it("QR の飛び先が未登録のイベントには、要求元のサイトのイベント詳細ページの URL を入れる", async () => {
    const config = await fetchConfig();
    expect(config.events.find((e) => e.id === "ev_pub")?.qrUrl).toBe(`${BASE}/events/ev_pub`);
  });

  it("200 で ETag は version。本文は SignageConfig の Zod 検査を通る", async () => {
    const res = await getConfig(req("/api/device/config", { token: tokenA }));
    expect(res.status).toBe(200);
    const body = await res.json();
    const config = signageConfigSchema.parse(body);
    expect(res.headers.get("etag")).toBe(`"${config.version}"`);
  });

  it("If-None-Match が一致すれば 304（本文なし）、違えば 200", async () => {
    const config = await fetchConfig();
    for (const inm of [`"${config.version}"`, config.version, `W/"${config.version}"`, `"x", "${config.version}"`]) {
      const res = await getConfig(req("/api/device/config", { token: tokenA, headers: { "if-none-match": inm } }));
      expect(res.status).toBe(304);
      expect(res.headers.get("etag")).toBe(`"${config.version}"`);
      expect(await res.text()).toBe("");
    }
    const other = await getConfig(req("/api/device/config", { token: tokenA, headers: { "if-none-match": `"${sha(1)}"` } }));
    expect(other.status).toBe(200);
  });

  it("中身: 公開・期間内のイベント、再生できる動画、現行バンドル、端末設定", async () => {
    const config = await fetchConfig();
    expect(config.events.map((e) => e.id)).toEqual(["ev_pub"]);
    expect(config.events[0].category).toEqual({ id: "cat_movie", name: "映画", color: "#A57BEA" });
    expect(config.events[0].image).toEqual({ mediaId: "img_event", sha256: sha(1), size: IMAGE_BYTES.length });
    expect(config.playlist).toEqual([{ mediaId: "vid_a", sha256: sha(2), size: VIDEO_BYTES.length, durationSeconds: 15 }]);
    expect(config.displayBundle).toEqual({ id: "b1", sha256: sha(100), size: BUNDLE_BYTES.length });
    expect(config.device).toEqual({ orientation: "portrait", width: 1080, height: 1920, volume: 0 });
    expect(config.house.rules).toHaveLength(3);
    expect(config.weather).toBeNull();
    expect(config.commands).toEqual({ testPlayRequestedAt: null });

    const configB = await fetchConfig(tokenB);
    expect(configB.playlist.map((p) => p.mediaId)).toEqual(["vid_b"]);
  });

  it("version は version を除いた本文をキー順固定にした JSON の SHA-256", async () => {
    const config = await fetchConfig();
    const { version, ...body } = config;
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(body)));
    expect(version).toBe(Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(""));
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: null }] })).toBe('{"a":[2,{"c":null,"d":1}],"b":1}');
  });

  it("内容が同じなら version は同じ。Heartbeat や下書きの変更では変わらない", async () => {
    const v1 = (await fetchConfig()).version;
    expect((await fetchConfig()).version).toBe(v1);
    await db.update(devices).set({ lastSeenAt: 123, agentVersion: "x" }).where(eq(devices.id, deviceA));
    await db.update(events).set({ title: "下書きを直した" }).where(eq(events.id, "ev_draft"));
    expect((await fetchConfig()).version).toBe(v1);
  });

  it("イベント・天気・バンドル公開のどれを変えても version が変わる", async () => {
    const seen = new Set([(await fetchConfig()).version]);
    const expectChanged = async () => {
      const v = (await fetchConfig()).version;
      expect(seen.has(v)).toBe(false);
      seen.add(v);
    };

    await db.update(events).set({ title: "映画会（変更）" }).where(eq(events.id, "ev_pub"));
    await expectChanged();

    await db.insert(weatherCache).values({ locationName: "横浜市", temperatureC: 21.5, condition: "clear", fetchedAt: 1_700_000_000 });
    await expectChanged();
    await db.update(weatherCache).set({ fetchedAt: 1_700_001_800 });
    await expectChanged();

    bucket.objects.set("bundles/b2.zip", BUNDLE_BYTES);
    await db.batch([
      db.update(displayBundles).set({ isCurrent: false }).where(eq(displayBundles.id, "b1")),
      db.insert(displayBundles).values({ id: "b2", sha256: sha(101), size: BUNDLE_BYTES.length, r2Key: "bundles/b2.zip", schemaVersion: 1, isCurrent: true }),
    ]);
    await expectChanged();
  });

  it("組み立て中に更新が割り込んでも、応答は検査を通り、更新前の世代のまま（次の取得で新しい世代）", async () => {
    // 読み取り中の別接続からの書き込みを通すため WAL にする（Turso はスナップショット分離。docs/spikes/workers.md 2 節）
    await db.$client.execute("PRAGMA journal_mode=WAL");
    const before = await fetchConfig();

    const client = db.$client;
    const original = client.transaction.bind(client);
    let wrote = false;
    const spy = vi.spyOn(client, "transaction").mockImplementation((async (...args: Parameters<typeof original>) => {
      const tx = await original(...args);
      const execute = tx.execute.bind(tx);
      tx.execute = (async (stmt: Parameters<typeof execute>[0]) => {
        const result = await execute(stmt);
        if (!wrote) {
          wrote = true;
          // 最初の読み取りの後に、イベント・天気・動画設定をまとめて更新する
          await db.batch([
            db.update(events).set({ title: "割り込み" }).where(eq(events.id, "ev_pub")),
            db.insert(weatherCache).values({ locationName: "横浜市", temperatureC: 10, condition: "rain", fetchedAt: 1_700_000_000 }),
            db.update(videoPlaybackSettings).set({ intervalMinutes: 30 }).where(eq(videoPlaybackSettings.deviceId, deviceA)),
          ]);
        }
        return result;
      }) as typeof tx.execute;
      return tx;
    }) as typeof client.transaction);

    const during = await fetchConfig();
    spy.mockRestore();
    expect(wrote).toBe(true);
    expect(() => signageConfigSchema.parse(during)).not.toThrow();
    expect(during).toEqual(before);

    const after = await fetchConfig();
    expect(after.version).not.toBe(before.version);
    expect(after.events[0].title).toBe("割り込み");
    expect(after.weather?.condition).toBe("rain");
    expect(after.video.intervalMinutes).toBe(30);
  });

  it("現行の表示バンドルが無ければ 503", async () => {
    await db.update(displayBundles).set({ isCurrent: false });
    const res = await getConfig(req("/api/device/config", { token: tokenA }));
    expect(res.status).toBe(503);
  });

  it("buildDeviceConfig の結果は SignageConfig の検査を通る", async () => {
    await db.insert(weatherCache).values({ locationName: "横浜市", temperatureC: 21.5, condition: "clear", fetchedAt: 1_700_000_000 });
    const config = await buildDeviceConfig(db, deviceA, nowSeconds());
    expect(signageConfigSchema.safeParse(config).success).toBe(true);
  });
});

// ---------------------------------------------------------------- 中継

describe("媒体・バンドルの中継", () => {
  it("config に含まれる動画は 200 で全体、Range で 206", async () => {
    const full = (await relay("/api/device/media/vid_a"))!;
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toBe("video/mp4");
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(VIDEO_BYTES);

    const part = (await relay("/api/device/media/vid_a", { headers: { range: "bytes=100-199" } }))!;
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe(`bytes 100-199/${VIDEO_BYTES.length}`);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(VIDEO_BYTES.slice(100, 200));

    const tail = (await relay("/api/device/media/vid_a", { headers: { range: "bytes=900-" } }))!;
    expect(tail.status).toBe(206);
    expect((await tail.arrayBuffer()).byteLength).toBe(100);
  });

  it("範囲外の Range は 416", async () => {
    const res = (await relay("/api/device/media/vid_a", { headers: { range: `bytes=${VIDEO_BYTES.length}-` } }))!;
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe(`bytes */${VIDEO_BYTES.length}`);
  });

  it("イベント画像も返す", async () => {
    const res = (await relay("/api/device/media/img_event"))!;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/png");
  });

  it("他端末のプレイリストの動画・再生できない動画・存在しない ID は 404", async () => {
    expect((await relay("/api/device/media/vid_b"))!.status).toBe(404);
    expect((await relay("/api/device/media/vid_unplayable"))!.status).toBe(404);
    expect((await relay("/api/device/media/nope"))!.status).toBe(404);
    // B からは取れる
    expect((await relay("/api/device/media/vid_b", { token: tokenB }))!.status).toBe(200);
  });

  it("現行のバンドルは返し、それ以外のバンドルは 404", async () => {
    const res = (await relay("/api/device/bundles/b1", { headers: { range: "bytes=0-9" } }))!;
    expect(res.status).toBe(206);
    expect(res.headers.get("content-type")).toBe("application/zip");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(BUNDLE_BYTES.slice(0, 10));

    bucket.objects.set("bundles/old.zip", BUNDLE_BYTES);
    await db.insert(displayBundles).values({ id: "old", sha256: sha(99), size: 300, r2Key: "bundles/old.zip", schemaVersion: 1, isCurrent: false });
    expect((await relay("/api/device/bundles/old"))!.status).toBe(404);
  });

  it("対象外の経路は null（vinext に渡す）", async () => {
    expect(await relay("/api/device/config")).toBeNull();
    expect(await relay("/api/device/media/a/b")).toBeNull();
  });
});

// ---------------------------------------------------------------- heartbeat

describe("POST /api/device/heartbeat", () => {
  const heartbeat = {
    agentVersion: "1.0.0",
    bundleId: "b1",
    appliedVersion: sha(5),
    pendingVersion: null,
    mode: "display",
    displayHealthy: true,
    nextVideoAt: 1_700_000_600,
    lastVideoFinishedAt: null,
    timeSynced: true,
    diskFreeBytes: 10_000_000,
    cpuTempC: 48.2,
    memAvailableBytes: 1_000_000,
  };

  it("最新値を保存し last_seen_at を進める（204）", async () => {
    const res = await postHeartbeat(post("/api/device/heartbeat", heartbeat));
    expect(res.status).toBe(204);
    const [row] = await db.select().from(devices).where(eq(devices.id, deviceA));
    expect(row.agentVersion).toBe("1.0.0");
    expect(row.cpuTempC).toBe(48.2);
    expect(row.lastSeenAt).not.toBeNull();
  });

  it("形式違いは 400", async () => {
    expect((await postHeartbeat(post("/api/device/heartbeat", { ...heartbeat, mode: "x" }))).status).toBe(400);
    const broken = req("/api/device/heartbeat", { method: "POST", token: tokenA, body: "{" });
    expect((await postHeartbeat(broken)).status).toBe(400);
  });
});

// ---------------------------------------------------------------- logs

describe("POST /api/device/logs", () => {
  const logs = (n: number) => ({ logs: Array.from({ length: n }, (_, i) => ({ type: "info", message: `m${i}`, createdAt: 1_700_000_000 + i })) });

  it("保存する（204）", async () => {
    expect((await postLogs(post("/api/device/logs", logs(3)))).status).toBe(204);
    const rows = await db.select().from(deviceLogs).where(eq(deviceLogs.deviceId, deviceA));
    expect(rows.map((r) => r.message).sort()).toEqual(["m0", "m1", "m2"]);
  });

  it("1 日 5,000 件を超える送信は 429 で 1 件も保存しない。他端末は数えない", async () => {
    const today = startOfTokyoDay(nowSeconds());
    await db.insert(deviceLogs).values(Array.from({ length: 4990 }, () => ({ deviceId: deviceA, type: "info", message: "x", createdAt: today })));
    // 前日分は数えない
    await db.insert(deviceLogs).values(Array.from({ length: 100 }, () => ({ deviceId: deviceA, type: "info", message: "y", createdAt: today - 1 })));

    const over = await postLogs(post("/api/device/logs", logs(11)));
    expect(over.status).toBe(429);
    expect(((await over.json()) as { error: { code: string } }).error.code).toBe("too_many_logs");
    const count = async () => (await db.select().from(deviceLogs).where(and(eq(deviceLogs.deviceId, deviceA), eq(deviceLogs.type, "info")))).length;
    expect(await count()).toBe(5090);

    expect((await postLogs(post("/api/device/logs", logs(10)))).status).toBe(204);
    expect(await count()).toBe(5100);
    expect((await postLogs(post("/api/device/logs", logs(1)))).status).toBe(429);
    expect((await postLogs(post("/api/device/logs", logs(1), tokenB))).status).toBe(204);
  });

  it("51 件以上や空は 400", async () => {
    expect((await postLogs(post("/api/device/logs", logs(51)))).status).toBe(400);
    expect((await postLogs(post("/api/device/logs", logs(0)))).status).toBe(400);
  });
});

// ---------------------------------------------------------------- media-failures

describe("POST /api/device/media-failures", () => {
  const failure = (over: Record<string, unknown>) => ({ reason: "hash_mismatch", quarantined: false, occurredAt: 1_700_000_000, ...over });

  it("同じ (端末, 媒体, 理由) は count を加算する。bundleId も受ける", async () => {
    let res = await postMediaFailures(post("/api/device/media-failures", { failures: [failure({ mediaId: "vid_a" })] }));
    expect(res.status).toBe(200);
    res = await postMediaFailures(
      post("/api/device/media-failures", {
        failures: [
          failure({ mediaId: "vid_a", quarantined: true, occurredAt: 1_700_000_100 }),
          failure({ mediaId: "vid_a", reason: "playback_failed" }),
          failure({ bundleId: "b1", reason: "download_failed" }),
          failure({ bundleId: "b1", reason: "download_failed" }),
        ],
      }),
    );
    expect(await res.json()).toEqual({ accepted: 4, ignored: 0 });

    const rows = await db.select().from(mediaFailures).where(eq(mediaFailures.deviceId, deviceA));
    const byKey = Object.fromEntries(rows.map((r) => [`${r.mediaId ?? r.bundleId}:${r.reason}`, r]));
    expect(byKey["vid_a:hash_mismatch"]).toMatchObject({ count: 2, quarantined: true, lastAt: 1_700_000_100 });
    expect(byKey["vid_a:playback_failed"]).toMatchObject({ count: 1 });
    expect(byKey["b1:download_failed"]).toMatchObject({ count: 2, mediaId: null });
    expect(rows).toHaveLength(3);
  });

  it("端末ごとに別に数える。存在しない ID は保存せず ignored に数える", async () => {
    await postMediaFailures(post("/api/device/media-failures", { failures: [failure({ mediaId: "vid_a" })] }));
    const res = await postMediaFailures(
      post("/api/device/media-failures", { failures: [failure({ mediaId: "vid_a" }), failure({ mediaId: "gone" }), failure({ bundleId: "gone" })] }, tokenB),
    );
    expect(await res.json()).toEqual({ accepted: 1, ignored: 2 });
    const rows = await db.select().from(mediaFailures);
    expect(rows.map((r) => [r.deviceId === deviceA ? "A" : "B", r.count]).sort()).toEqual([
      ["A", 1],
      ["B", 1],
    ]);
  });

  it("mediaId と bundleId の両方・どちらもなしは 400", async () => {
    expect((await postMediaFailures(post("/api/device/media-failures", { failures: [failure({ mediaId: "vid_a", bundleId: "b1" })] }))).status).toBe(400);
    expect((await postMediaFailures(post("/api/device/media-failures", { failures: [failure({})] }))).status).toBe(400);
  });
});
