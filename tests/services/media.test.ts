/**
 * メディアのサービス層（lib/services/media.ts）と R2 中継（lib/r2.ts）。
 * DB は一時 libSQL ファイル、R2 はメモリ上の偽物（本物と同じく、完了済みのマルチパートへの complete は失敗する）。
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../db/index";
import {
  devices,
  displayBundles,
  events,
  houseSettings,
  media,
  mediaFailures,
  notices,
  playlistItems,
  playlists,
  uploads,
  users,
} from "../../db/schema";
import type { AuthUser } from "../../lib/auth";
import { UPLOAD_PART_SIZE } from "../../lib/file-sniff";
import { parseRange, serveObject, type MediaBucket, type R2Multipart, type R2Part, type R2Range } from "../../lib/r2";
import {
  DELETE_DELAY_SECONDS,
  MediaError,
  abortUpload,
  completeUpload,
  isPlayable,
  listMedia,
  listMediaFailures,
  purgeDeletedMedia,
  requestMediaDeletion,
  startUpload,
  uploadPart,
  type CompleteUploadInput,
  type MediaDeps,
  type VideoCodecInfo,
} from "../../lib/services/media";
import { openTempDb } from "../helpers/temp-db";

// ---------------------------------------------------------------- R2 の偽物

class FakeBucket implements MediaBucket {
  objects = new Map<string, Uint8Array>();
  pending = new Map<string, { key: string; parts: Map<number, { etag: string; data: Uint8Array }> }>();
  failDeleteFor = new Set<string>();

  async createMultipartUpload(key: string): Promise<R2Multipart> {
    const uploadId = crypto.randomUUID();
    this.pending.set(uploadId, { key, parts: new Map() });
    return this.resumeMultipartUpload(key, uploadId);
  }

  resumeMultipartUpload(key: string, uploadId: string): R2Multipart {
    const pending = () => {
      const p = this.pending.get(uploadId);
      if (!p || p.key !== key) throw new Error("NoSuchUpload");
      return p;
    };
    return {
      key,
      uploadId,
      uploadPart: async (partNumber, value) => {
        const p = pending();
        const data = value instanceof Uint8Array ? value.slice() : new Uint8Array(await new Response(value).arrayBuffer());
        const etag = crypto.randomUUID();
        p.parts.set(partNumber, { etag, data });
        return { partNumber, etag };
      },
      abort: async () => {
        pending();
        this.pending.delete(uploadId);
      },
      complete: async (parts: R2Part[]) => {
        const p = pending();
        const chunks = parts.map(({ partNumber, etag }) => {
          const part = p.parts.get(partNumber);
          if (!part || part.etag !== etag) throw new Error("InvalidPart");
          return part.data;
        });
        const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
        let o = 0;
        for (const c of chunks) {
          all.set(c, o);
          o += c.length;
        }
        this.objects.set(key, all);
        this.pending.delete(uploadId);
        return { size: all.length, httpEtag: `"${key}"` };
      },
    };
  }

  async head(key: string) {
    const data = this.objects.get(key);
    return data ? { size: data.length, httpEtag: `"${key}"` } : null;
  }

  async get(key: string, options?: { range?: R2Range }) {
    const data = this.objects.get(key);
    if (!data) return null;
    let slice = data;
    const r = options?.range;
    if (r) slice = "suffix" in r ? data.subarray(data.length - r.suffix) : data.subarray(r.offset, r.offset + r.length);
    const copy = slice.slice();
    return {
      size: data.length,
      httpEtag: `"${key}"`,
      body: new Response(copy).body as ReadableStream<Uint8Array>,
      arrayBuffer: async () => copy.buffer,
    };
  }

  async put(key: string, value: Uint8Array) {
    this.objects.set(key, value.slice());
    return { size: value.length, httpEtag: `"${key}"` };
  }

  async delete(keys: string | string[]) {
    for (const k of [keys].flat()) {
      if (this.failDeleteFor.has(k)) throw new Error("R2 down");
      this.objects.delete(k);
    }
  }
}

// ---------------------------------------------------------------- 準備

const MB = 1024 * 1024;
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
const MP4_HEAD = [0, 0, 0, 0x20, ...ascii("ftypisom"), 0, 0, 2, 0];
const JPEG_HEAD = [0xff, 0xd8, 0xff, 0xe0, 0, 0x10, ...ascii("JFIF")];
const WEBP_HEAD = [...ascii("RIFF"), 0x24, 0, 0, 0, ...ascii("WEBPVP8 ")];
const SVG_HEAD = ascii('<svg xmlns="http://www.w3.org/2000/svg">');

/** 先頭に head を置いた size バイトのファイル */
function file(head: number[], size: number): Uint8Array {
  const data = new Uint8Array(size);
  for (let i = 0; i < size; i++) data[i] = (i * 31) & 0xff;
  data.set(head.slice(0, size));
  return data;
}

const H264_1080P: VideoCodecInfo = {
  container: "mp4",
  codec: "avc1",
  profile: 100,
  level: 40,
  width: 1920,
  height: 1080,
  fps: 30,
  chromaFormat: "4:2:0",
  bitDepth: 8,
};

let db: Db;
let close: () => void;
let bucket: FakeBucket;
let deps: MediaDeps;
let staff: AuthUser;
let other: AuthUser;

async function addUser(email: string): Promise<AuthUser> {
  const [row] = await db.insert(users).values({ email, name: email, role: "staff" }).returning();
  return { id: row.id, email: row.email, name: row.name, role: row.role };
}

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  bucket = new FakeBucket();
  deps = { db, bucket };
  staff = await addUser("staff@example.com");
  other = await addUser("other@example.com");
});

afterEach(() => close());

async function sendParts(uploadId: string, data: Uint8Array, user = staff): Promise<R2Part[]> {
  const parts: R2Part[] = [];
  for (let n = 1; (n - 1) * UPLOAD_PART_SIZE < data.length; n++) {
    const chunk = data.subarray((n - 1) * UPLOAD_PART_SIZE, n * UPLOAD_PART_SIZE);
    parts.push(await uploadPart(deps, user, uploadId, n, new Response(chunk.slice()).body, chunk.length));
  }
  return parts;
}

const meta = (parts: R2Part[], extra: Partial<CompleteUploadInput> = {}): CompleteUploadInput => ({
  name: "clip.mp4",
  sha256: "a".repeat(64),
  parts,
  durationSeconds: 12.5,
  codecInfo: H264_1080P,
  ...extra,
});

async function uploadVideo(size = 12 * MB) {
  const data = file(MP4_HEAD, size);
  const { uploadId } = await startUpload(deps, staff, { kind: "video", size });
  const parts = await sendParts(uploadId, data);
  return { uploadId, parts, data };
}

async function expectMediaError(p: Promise<unknown>, status: number, code?: string) {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(MediaError);
  expect((e as MediaError).status).toBe(status);
  if (code) expect((e as MediaError).code).toBe(code);
}

// ---------------------------------------------------------------- アップロード

describe("アップロード", () => {
  it("動画 12MB を 2 パートで送り、完了すると media ができる（キーはサーバーが決める）", async () => {
    const { uploadId, parts, data } = await uploadVideo();
    expect(parts.map((p) => p.partNumber)).toEqual([1, 2]);

    const row = await completeUpload(deps, staff, uploadId, meta(parts), new Uint8Array([...WEBP_HEAD, 1, 2, 3]));
    expect(row).toMatchObject({
      type: "video",
      mimeType: "video/mp4",
      fileSize: 12 * MB,
      width: 1920,
      height: 1080,
      durationSeconds: 12.5,
      playable: true,
      state: "active",
    });
    expect(row.r2Key).toBe(`media/${uploadId}/original`);
    expect(row.thumbnailR2Key).toBe(`media/${uploadId}/thumbnail`);
    expect(Buffer.compare(bucket.objects.get(row.r2Key)!, data)).toBe(0); // 大きい配列は toEqual だと遅い

    const [up] = await db.select().from(uploads).where(eq(uploads.id, uploadId));
    expect(up).toMatchObject({ state: "completed", mediaId: row.id });
    expect((await listMedia(db)).map((m) => m.id)).toEqual([row.id]);
  });

  it("上限超過は開始時に 413（画像 20MB・動画 12MB）", async () => {
    await expectMediaError(startUpload(deps, staff, { kind: "image", size: 20 * MB + 1 }), 413, "too_large");
    await expectMediaError(startUpload(deps, staff, { kind: "video", size: 12 * MB + 1 }), 413, "too_large");
    await expect(startUpload(deps, staff, { kind: "image", size: 20 * MB })).resolves.toBeTruthy();
    await expect(startUpload(deps, staff, { kind: "video", size: 12 * MB })).resolves.toBeTruthy();
    expect(bucket.pending.size).toBe(2);
  });

  it("動画の尺は 20 秒まで（書き出しの端数 0.5 秒は許す）。超える・長さが分からない動画は完了時に 400 で、R2 の途中のアップロードも捨てる", async () => {
    const long = await uploadVideo(12 * MB);
    await expectMediaError(completeUpload(deps, staff, long.uploadId, meta(long.parts, { durationSeconds: 30 })), 400, "video_too_long");
    const [aborted] = await db.select().from(uploads).where(eq(uploads.id, long.uploadId));
    expect(aborted.state).toBe("aborted");
    expect(bucket.pending.has(aborted.r2UploadId)).toBe(false);

    const unknown = await uploadVideo(12 * MB);
    await expectMediaError(completeUpload(deps, staff, unknown.uploadId, meta(unknown.parts, { durationSeconds: null })), 400, "video_too_long");

    const ok = await uploadVideo(12 * MB);
    const row = await completeUpload(deps, staff, ok.uploadId, meta(ok.parts, { durationSeconds: 20.4 }));
    expect(row.durationSeconds).toBe(20.4);
    expect(await db.select().from(media)).toHaveLength(1);
  });

  it("アップロードする動画の本数は制限しない（3 本までは再生リストの側。再生リストから外した動画が残っていても入れられる）", async () => {
    for (let i = 0; i < 4; i++) {
      const { uploadId, parts } = await uploadVideo(12 * MB);
      await completeUpload(deps, staff, uploadId, meta(parts));
    }
    expect(await db.select().from(media).where(eq(media.type, "video"))).toHaveLength(4);
  });

  it("種類・大きさが不正な開始は入力エラー", async () => {
    await expect(startUpload(deps, staff, { kind: "svg" as never, size: 10 })).rejects.toThrow();
    await expect(startUpload(deps, staff, { kind: "image", size: 0 })).rejects.toThrow();
  });

  it("SVG は 1 パート目で 415 になり、アップロードは中断される", async () => {
    const data = file(SVG_HEAD, 2000);
    const { uploadId } = await startUpload(deps, staff, { kind: "image", size: data.length });
    await expectMediaError(sendParts(uploadId, data), 415, "unsupported_type");

    const [up] = await db.select().from(uploads).where(eq(uploads.id, uploadId));
    expect(up.state).toBe("aborted");
    expect(bucket.pending.size).toBe(0);
  });

  it("拡張子・種類の偽装（動画として JPEG の中身、画像として MP4 の中身）は 415", async () => {
    const jpeg = file(JPEG_HEAD, 3000);
    const a = await startUpload(deps, staff, { kind: "video", size: jpeg.length });
    await expectMediaError(sendParts(a.uploadId, jpeg), 415);

    const mp4 = file(MP4_HEAD, 3000);
    const b = await startUpload(deps, staff, { kind: "image", size: mp4.length });
    await expectMediaError(sendParts(b.uploadId, mp4), 415);
  });

  it("パートの大きさ・番号が宣言と合わなければ 400（宣言サイズを超えて送れない）", async () => {
    const { uploadId } = await startUpload(deps, staff, { kind: "video", size: 12 * MB });
    const body = () => new Response(new Uint8Array(10)).body;
    await expectMediaError(uploadPart(deps, staff, uploadId, 1, body(), 10), 400, "invalid_part");
    await expectMediaError(uploadPart(deps, staff, uploadId, 2, body(), 10), 400, "invalid_part");
    await expectMediaError(uploadPart(deps, staff, uploadId, 3, body(), 5 * MB), 400, "invalid_part");
    await expectMediaError(uploadPart(deps, staff, uploadId, 0, body(), 10), 400, "invalid_part");
    await expectMediaError(uploadPart(deps, staff, uploadId, 1, null, UPLOAD_PART_SIZE), 400, "invalid_part");
  });

  it("開始したユーザー以外はパート送信・完了・中断ができない（403）", async () => {
    const data = file(MP4_HEAD, 1000);
    const { uploadId } = await startUpload(deps, staff, { kind: "video", size: data.length });
    await expectMediaError(sendParts(uploadId, data, other), 403, "forbidden");
    const parts = await sendParts(uploadId, data);
    await expectMediaError(completeUpload(deps, other, uploadId, meta(parts)), 403);
    await expectMediaError(abortUpload(deps, other, uploadId), 403);
    await expectMediaError(uploadPart(deps, staff, "no-such-upload", 1, null, 0), 404);
  });

  it("complete を 2 回呼んでも media は 1 件で、同じものを返す", async () => {
    const { uploadId, parts } = await uploadVideo(12 * MB);
    const first = await completeUpload(deps, staff, uploadId, meta(parts));
    const second = await completeUpload(deps, staff, uploadId, meta(parts));
    expect(second.id).toBe(first.id);
    expect(await db.select().from(media)).toHaveLength(1);
  });

  it("complete を同時に呼んでも media は 1 件", async () => {
    const { uploadId, parts } = await uploadVideo(12 * MB);
    const results = await Promise.all([1, 2, 3].map(() => completeUpload(deps, staff, uploadId, meta(parts))));
    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(await db.select().from(media)).toHaveLength(1);
  });

  it("R2 の完了後に DB が失敗しても、再送で完了し media は 1 件", async () => {
    const { uploadId, parts } = await uploadVideo(12 * MB);
    const insert = vi.spyOn(db, "insert").mockImplementationOnce(() => {
      throw new Error("db down");
    });
    await expect(completeUpload(deps, staff, uploadId, meta(parts))).rejects.toThrow("db down");
    insert.mockRestore();
    expect(bucket.pending.size).toBe(0); // R2 側は完了済み

    const row = await completeUpload(deps, staff, uploadId, meta(parts));
    expect(row.fileSize).toBe(12 * MB);
    expect(await db.select().from(media)).toHaveLength(1);
  });

  it("パートが足りない complete は 400、R2 が本体を持たなければ 409", async () => {
    const { uploadId, parts } = await uploadVideo(12 * MB);
    await expectMediaError(completeUpload(deps, staff, uploadId, meta(parts.slice(0, 1))), 400, "invalid_parts");
    const wrongEtag = parts.map((p) => ({ ...p, etag: "x" }));
    await expectMediaError(completeUpload(deps, staff, uploadId, meta(wrongEtag)), 409, "upload_incomplete");
    expect(await db.select().from(media)).toHaveLength(0);
  });

  it("サムネイルは WebP だけ受け付ける", async () => {
    const { uploadId, parts } = await uploadVideo(1000);
    await expectMediaError(
      completeUpload(deps, staff, uploadId, meta(parts), new Uint8Array(SVG_HEAD)),
      415,
      "invalid_thumbnail",
    );
  });

  it("中断後はパートも完了も受け付けない。中断は 2 回目も成功、完了後の中断は 409", async () => {
    const data = file(MP4_HEAD, 1000);
    const { uploadId } = await startUpload(deps, staff, { kind: "video", size: data.length });
    await abortUpload(deps, staff, uploadId);
    await abortUpload(deps, staff, uploadId);
    await expectMediaError(sendParts(uploadId, data), 409, "not_uploading");
    await expectMediaError(completeUpload(deps, staff, uploadId, meta([{ partNumber: 1, etag: "x" }])), 409, "aborted");

    const done = await uploadVideo(1000);
    await completeUpload(deps, staff, done.uploadId, meta(done.parts));
    await expectMediaError(abortUpload(deps, staff, done.uploadId), 409, "completed");
  });

  it("画像は playable にならず、コーデック情報・尺を持たない", async () => {
    const data = file(JPEG_HEAD, 5000);
    const { uploadId } = await startUpload(deps, staff, { kind: "image", size: data.length });
    const parts = await sendParts(uploadId, data);
    const row = await completeUpload(deps, staff, uploadId, meta(parts, { name: "a.jpg", width: 800, height: 600 }));
    expect(row).toMatchObject({ type: "image", mimeType: "image/jpeg", playable: false, codecInfo: null, durationSeconds: null });
    expect(row).toMatchObject({ width: 800, height: 600 });
  });
});

// ---------------------------------------------------------------- 再生可否

describe("isPlayable（要件定義書 15 節の推奨）", () => {
  it.each<[string, Partial<VideoCodecInfo>, boolean]>([
    ["H.264 1080p 30fps yuv420p", {}, true],
    ["縦長 1080x1920", { width: 1080, height: 1920 }, true],
    ["29.97fps", { fps: 29.97 }, true],
    ["720p Main", { width: 1280, height: 720, profile: 77 }, true],
    ["H.265（HEVC）8bit", { codec: "hvc1", profile: 1 }, true],
    ["H.265（hev1）10bit（iPhone の HDR）", { codec: "hev1", profile: 2, bitDepth: 10 }, true],
    ["H.265 で色の形式・ビット数の記録なし（読む前にアップロードしたもの）", { codec: "hvc1", chromaFormat: null, bitDepth: null }, true],
    ["H.265 4:2:2", { codec: "hvc1", chromaFormat: "4:2:2" }, false],
    ["H.265 60fps", { codec: "hvc1", fps: 60 }, false],
    ["H.265 4K", { codec: "hvc1", width: 3840, height: 2160 }, false],
    ["VP9 など", { codec: "vp09" }, false],
    ["4K", { width: 3840, height: 2160 }, false],
    ["1440x1440", { width: 1440, height: 1440 }, false],
    ["60fps", { fps: 60 }, false],
    ["fps 不明", { fps: null }, false],
    ["4:2:2", { chromaFormat: "4:2:2" }, false],
    ["10bit", { bitDepth: 10 }, false],
    ["色形式不明", { chromaFormat: null }, false],
  ])("%s → %s", (_label, patch, expected) => {
    expect(isPlayable("video/mp4", { ...H264_1080P, ...patch })).toBe(expected);
  });

  it("MP4 以外・情報なしは false", () => {
    expect(isPlayable("image/jpeg", H264_1080P)).toBe(false);
    expect(isPlayable("video/mp4", null)).toBe(false);
  });

  it("条件を外れた動画も登録はでき、playable = false で保存される", async () => {
    const { uploadId, parts } = await uploadVideo(1000);
    const row = await completeUpload(deps, staff, uploadId, meta(parts, { codecInfo: { ...H264_1080P, fps: 60 } }));
    expect(row.playable).toBe(false);
    expect(row.codecInfo).toMatchObject({ fps: 60 });
  });
});

// ---------------------------------------------------------------- 削除

describe("削除予約と削除の実行", () => {
  const NOW = 1_800_000_000;

  async function newMedia() {
    const { uploadId, parts } = await uploadVideo(1000);
    return completeUpload(deps, staff, uploadId, meta(parts), new Uint8Array(WEBP_HEAD));
  }

  it("参照が無ければ deleting にし、7 日後を delete_after にする。一覧から消える", async () => {
    const m = await newMedia();
    await requestMediaDeletion(db, m.id, NOW);
    const [row] = await db.select().from(media).where(eq(media.id, m.id));
    expect(row).toMatchObject({ state: "deleting", deleteAfter: NOW + DELETE_DELAY_SECONDS });
    expect(await listMedia(db)).toHaveLength(0);
    // 2 回目も成功（期限は変えない）
    await requestMediaDeletion(db, m.id, NOW + 100);
    const [again] = await db.select().from(media).where(eq(media.id, m.id));
    expect(again.deleteAfter).toBe(NOW + DELETE_DELAY_SECONDS);
  });

  it.each([
    ["イベントの画像", async (id: string) => void (await db.insert(events).values({ title: "e", startAt: NOW, imageMediaId: id }))],
    ["お知らせの画像", async (id: string) => void (await db.insert(notices).values({ title: "n", imageMediaId: id }))],
    ["デザイン設定のロゴ", async (id: string) => void (await db.insert(houseSettings).values({ houseName: "h", logoMediaId: id }))],
    [
      "デザイン設定のフッター画像",
      async (id: string) => void (await db.insert(houseSettings).values({ houseName: "h", footerImageMediaId: id })),
    ],
    [
      "プレイリスト",
      async (id: string) => {
        const [p] = await db.insert(playlists).values({ name: "p" }).returning();
        await db.insert(playlistItems).values({ playlistId: p.id, mediaId: id, position: 0 });
      },
    ],
  ])("%s から参照中は 409 で、state は active のまま", async (_label, addRef) => {
    const m = await newMedia();
    await addRef(m.id);
    await expectMediaError(requestMediaDeletion(db, m.id, NOW), 409, "in_use");
    const [row] = await db.select().from(media).where(eq(media.id, m.id));
    expect(row.state).toBe("active");
  });

  it("存在しない media は 404", async () => {
    await expectMediaError(requestMediaDeletion(db, "nope", NOW), 404);
  });

  it("purgeDeletedMedia は期限を過ぎたものだけ R2 と DB から消し、失敗したものは残す", async () => {
    const due = await newMedia();
    const notYet = await newMedia();
    const failing = await newMedia();
    await requestMediaDeletion(db, due.id, NOW);
    await requestMediaDeletion(db, notYet.id, NOW + 10);
    await requestMediaDeletion(db, failing.id, NOW);
    bucket.failDeleteFor.add(failing.r2Key);

    const result = await purgeDeletedMedia(deps, NOW + DELETE_DELAY_SECONDS);
    expect(result).toEqual({ purged: [due.id], failed: [failing.id] });
    expect(bucket.objects.has(due.r2Key)).toBe(false);
    expect(bucket.objects.has(due.thumbnailR2Key!)).toBe(false);
    expect(bucket.objects.has(notYet.r2Key)).toBe(true);
    const ids = (await db.select().from(media)).map((r) => r.id).sort();
    expect(ids).toEqual([notYet.id, failing.id].sort());

    // 次回に再試行される
    bucket.failDeleteFor.clear();
    expect(await purgeDeletedMedia(deps, NOW + DELETE_DELAY_SECONDS)).toEqual({ purged: [failing.id], failed: [] });
  });
});

// ---------------------------------------------------------------- 中継

describe("listMediaFailures（端末が報告した失敗）", () => {
  it("画像・動画の失敗を端末名つきで新しい順に返し、表示バンドルの失敗は含めない", async () => {
    const { uploadId, parts } = await uploadVideo(1000);
    const m = await completeUpload(deps, staff, uploadId, meta(parts));
    const [device] = await db.insert(devices).values({ name: "エントランス", tokenHash: "h".repeat(64) }).returning();
    const [bundle] = await db
      .insert(displayBundles)
      .values({ sha256: "b".repeat(64), size: 1, r2Key: "bundles/x.zip", schemaVersion: 1 })
      .returning();
    await db.insert(mediaFailures).values([
      { deviceId: device.id, mediaId: m.id, reason: "download_failed", quarantined: false, count: 1, lastAt: 100 },
      { deviceId: device.id, mediaId: m.id, reason: "playback_failed", quarantined: true, count: 3, lastAt: 200 },
      { deviceId: device.id, bundleId: bundle.id, reason: "hash_mismatch", quarantined: false, count: 1, lastAt: 300 },
    ]);

    const failures = await listMediaFailures(db);
    expect(failures).toEqual([
      {
        mediaId: m.id,
        deviceId: device.id,
        deviceName: "エントランス",
        reason: "playback_failed",
        quarantined: true,
        count: 3,
        lastAt: 200,
      },
      {
        mediaId: m.id,
        deviceId: device.id,
        deviceName: "エントランス",
        reason: "download_failed",
        quarantined: false,
        count: 1,
        lastAt: 100,
      },
    ]);
  });
});

describe("parseRange", () => {
  it.each<[string | null, ReturnType<typeof parseRange>]>([
    [null, { kind: "full" }],
    ["bytes=0-99", { kind: "partial", offset: 0, length: 100 }],
    ["bytes=900-", { kind: "partial", offset: 900, length: 100 }],
    ["bytes=-10", { kind: "partial", offset: 990, length: 10 }],
    ["bytes=-5000", { kind: "partial", offset: 0, length: 1000 }],
    ["bytes=990-5000", { kind: "partial", offset: 990, length: 10 }],
    ["bytes=1000-", { kind: "unsatisfiable" }],
    ["bytes=-0", { kind: "unsatisfiable" }],
    ["bytes=0-1,5-9", { kind: "full" }],
    ["bytes=9-1", { kind: "full" }],
    ["items=0-1", { kind: "full" }],
  ])("%s", (header, expected) => {
    expect(parseRange(header, 1000)).toEqual(expected);
  });
});

describe("serveObject", () => {
  const key = "media/x/original";
  const data = file(MP4_HEAD, 1000);
  const req = (headers: Record<string, string> = {}, method = "GET") =>
    new Request("https://signage.example/api/media/x/file", { method, headers });

  beforeEach(() => {
    bucket.objects.set(key, data);
  });

  it("全体は 200。Content-Type は検査済みの値、nosniff 付き", async () => {
    const res = await serveObject(bucket, req(), { key, size: 1000, contentType: "video/mp4" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-length")).toBe("1000");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(data);
  });

  it("Range は 206 と Content-Range", async () => {
    const res = await serveObject(bucket, req({ range: "bytes=100-199" }), { key, size: 1000, contentType: "video/mp4" });
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe("bytes 100-199/1000");
    expect(res.headers.get("content-length")).toBe("100");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(data.subarray(100, 200));
  });

  it("範囲外は 416", async () => {
    const res = await serveObject(bucket, req({ range: "bytes=5000-" }), { key, size: 1000, contentType: "video/mp4" });
    expect(res.status).toBe(416);
    expect(res.headers.get("content-range")).toBe("bytes */1000");
  });

  it("HEAD は本文なし、R2 に無ければ 404", async () => {
    const head = await serveObject(bucket, req({}, "HEAD"), { key, size: 1000, contentType: "video/mp4" });
    expect(head.status).toBe(200);
    expect(head.body).toBeNull();
    const missing = await serveObject(bucket, req(), { key: "nope", size: 1, contentType: "image/webp" });
    expect(missing.status).toBe(404);
  });
});
