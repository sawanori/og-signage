/**
 * worker/scheduled.ts（task_013）。DB は一時 libSQL ファイル、R2 はメモリ上の偽物、getDb/getMediaBucket は差し替える。
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../db/index";
import { deviceLogs, devices, media, uploads, users } from "../../db/schema";
import type { MediaBucket, R2Multipart, R2Part } from "../../lib/r2";
import { openTempDb } from "../helpers/temp-db";

// ---------------------------------------------------------------- R2 の偽物（削除・中断だけ使う）

class FakeBucket implements MediaBucket {
  objects = new Map<string, Uint8Array>();
  pending = new Map<string, { key: string }>();
  deleted: string[] = [];
  aborted: string[] = [];
  private noSuchUpload = new Set<string>();

  registerPendingUpload(uploadId: string, key: string) {
    this.pending.set(uploadId, { key });
  }
  markGone(uploadId: string) {
    this.noSuchUpload.add(uploadId);
  }

  async createMultipartUpload(key: string): Promise<R2Multipart> {
    const uploadId = crypto.randomUUID();
    this.pending.set(uploadId, { key });
    return this.resumeMultipartUpload(key, uploadId);
  }

  resumeMultipartUpload(key: string, uploadId: string): R2Multipart {
    return {
      key,
      uploadId,
      uploadPart: async (partNumber: number) => ({ partNumber, etag: "x" }) as R2Part,
      abort: async () => {
        if (this.noSuchUpload.has(uploadId)) throw new Error("NoSuchUpload");
        this.pending.delete(uploadId);
        this.aborted.push(uploadId);
      },
      complete: async () => ({ size: 0, httpEtag: `"${key}"` }),
    };
  }

  async head(key: string) {
    const data = this.objects.get(key);
    return data ? { size: data.length, httpEtag: `"${key}"` } : null;
  }

  async get(key: string) {
    const data = this.objects.get(key);
    if (!data) return null;
    const copy = data.slice();
    return { size: data.length, httpEtag: `"${key}"`, body: new Response(copy).body as ReadableStream<Uint8Array>, arrayBuffer: async () => copy.buffer };
  }

  async put(key: string, value: Uint8Array) {
    this.objects.set(key, value.slice());
    return { size: value.length, httpEtag: `"${key}"` };
  }

  async delete(keys: string | string[]) {
    for (const k of [keys].flat()) {
      this.deleted.push(k);
      this.objects.delete(k);
    }
  }
}

// ---------------------------------------------------------------- 依存の差し替え

const state = vi.hoisted(() => ({ db: null as unknown as Db, bucket: null as unknown as FakeBucket }));

vi.mock("../../lib/runtime", () => ({ getDb: () => state.db }));
vi.mock("../../lib/r2", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/r2")>();
  return { ...actual, getMediaBucket: () => state.bucket };
});
vi.mock("../../lib/weather", () => ({ refreshWeather: vi.fn(async () => {}) }));

const { abortStaleUploads, purgeOldDeviceLogs, scheduled, WEATHER_CRON, DAILY_CRON } = await import("../../worker/scheduled");
const { refreshWeather } = await import("../../lib/weather");

const DAY = 24 * 60 * 60;

let db: Db;
let close: () => void;
let bucket: FakeBucket;

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  bucket = new FakeBucket();
  state.db = db;
  state.bucket = bucket;
  vi.clearAllMocks();
});

afterEach(() => close());

async function addUser(): Promise<string> {
  const [row] = await db.insert(users).values({ email: `${crypto.randomUUID()}@example.com`, role: "staff" }).returning({ id: users.id });
  return row.id;
}

async function addDevice(): Promise<string> {
  const [row] = await db.insert(devices).values({ name: "リビング", tokenHash: crypto.randomUUID() }).returning({ id: devices.id });
  return row.id;
}

async function addUpload(userId: string, state_: "uploading" | "completed" | "aborted", createdAt: number) {
  const r2Key = `media/${crypto.randomUUID()}/original`;
  const uploadId = crypto.randomUUID();
  bucket.registerPendingUpload(uploadId, r2Key);
  const [row] = await db
    .insert(uploads)
    .values({ userId, kind: "video", r2Key, r2UploadId: uploadId, declaredSize: 1000, state: state_, createdAt })
    .returning();
  return row;
}

describe("abortStaleUploads", () => {
  it("24時間以上 uploading のままの upload を中断する", async () => {
    const userId = await addUser();
    const now = Math.floor(Date.now() / 1000);
    const stale = await addUpload(userId, "uploading", now - DAY - 60);

    const result = await abortStaleUploads(db, bucket, now);

    expect(result.abortedIds).toEqual([stale.id]);
    expect(bucket.aborted).toContain(stale.r2UploadId);
    const [row] = await db.select().from(uploads).where(eq(uploads.id, stale.id));
    expect(row.state).toBe("aborted");
  });

  it("24時間未満の uploading はそのまま", async () => {
    const userId = await addUser();
    const now = Math.floor(Date.now() / 1000);
    const fresh = await addUpload(userId, "uploading", now - 60);

    const result = await abortStaleUploads(db, bucket, now);

    expect(result.abortedIds).toEqual([]);
    const [row] = await db.select().from(uploads).where(eq(uploads.id, fresh.id));
    expect(row.state).toBe("uploading");
  });

  it("completed・aborted 済みの古い upload には触らない", async () => {
    const userId = await addUser();
    const now = Math.floor(Date.now() / 1000);
    const completed = await addUpload(userId, "completed", now - DAY - 60);

    const result = await abortStaleUploads(db, bucket, now);

    expect(result.abortedIds).toEqual([]);
    const [row] = await db.select().from(uploads).where(eq(uploads.id, completed.id));
    expect(row.state).toBe("completed");
  });

  it("R2 側の中断が失敗しても（すでに無い等）DB は aborted にする", async () => {
    const userId = await addUser();
    const now = Math.floor(Date.now() / 1000);
    const stale = await addUpload(userId, "uploading", now - DAY - 60);
    bucket.markGone(stale.r2UploadId);

    const result = await abortStaleUploads(db, bucket, now);

    expect(result.abortedIds).toEqual([stale.id]);
    const [row] = await db.select().from(uploads).where(eq(uploads.id, stale.id));
    expect(row.state).toBe("aborted");
  });
});

describe("purgeOldDeviceLogs", () => {
  it("30日より古い device_logs を削除し、新しいものは残す", async () => {
    const deviceId = await addDevice();
    const now = Math.floor(Date.now() / 1000);
    const RETENTION = 30 * DAY;
    const [old] = await db.insert(deviceLogs).values({ deviceId, type: "info", message: "old", createdAt: now - RETENTION - 60 }).returning();
    const [fresh] = await db.insert(deviceLogs).values({ deviceId, type: "info", message: "fresh", createdAt: now - 60 }).returning();

    const deletedCount = await purgeOldDeviceLogs(db, now);

    expect(deletedCount).toBe(1);
    const remaining = await db.select().from(deviceLogs);
    expect(remaining.map((r) => r.id)).toEqual([fresh.id]);
    expect(remaining.some((r) => r.id === old.id)).toBe(false);
  });

  it("対象が無ければ何も削除しない", async () => {
    const deviceId = await addDevice();
    const now = Math.floor(Date.now() / 1000);
    await db.insert(deviceLogs).values({ deviceId, type: "info", message: "fresh", createdAt: now - 60 });

    const deletedCount = await purgeOldDeviceLogs(db, now);
    expect(deletedCount).toBe(0);
  });
});

describe("scheduled", () => {
  it(`${WEATHER_CRON} は天気の取得だけを行う`, async () => {
    await scheduled(WEATHER_CRON);
    expect(refreshWeather).toHaveBeenCalledTimes(1);
  });

  it(`${DAILY_CRON} は削除予約・停滞アップロード・古いログの掃除をまとめて行う`, async () => {
    const userId = await addUser();
    const deviceId = await addDevice();
    const now = Math.floor(Date.now() / 1000);

    // 削除予約の期限切れ media
    const r2Key = `media/${crypto.randomUUID()}/original`;
    bucket.objects.set(r2Key, new Uint8Array([1, 2, 3]));
    const [dueMedia] = await db
      .insert(media)
      .values({ name: "old.mp4", type: "video", r2Key, state: "deleting", deleteAfter: now - 60 })
      .returning();

    // 停滞アップロード
    const staleUpload = await addUpload(userId, "uploading", now - DAY - 60);

    // 古い device_logs
    await db.insert(deviceLogs).values({ deviceId, type: "info", message: "old", createdAt: now - 30 * DAY - 60 });

    await scheduled(DAILY_CRON);

    expect(refreshWeather).not.toHaveBeenCalled();

    const mediaRows = await db.select().from(media).where(eq(media.id, dueMedia.id));
    expect(mediaRows).toHaveLength(0);
    expect(bucket.deleted).toContain(r2Key);

    const [uploadRow] = await db.select().from(uploads).where(eq(uploads.id, staleUpload.id));
    expect(uploadRow.state).toBe("aborted");

    const logs = await db.select().from(deviceLogs);
    expect(logs).toHaveLength(0);
  });

  it("未登録の cron 式では何もしない", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await scheduled("0 0 1 1 *");
    expect(refreshWeather).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });
});
