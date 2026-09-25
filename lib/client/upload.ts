/**
 * ブラウザ側のアップロード（管理画面から使う）。
 *
 * - 画像: WebP・長辺 1920px 以下に縮小してから送る。
 * - 動画: mp4 のボックスを読んでコーデック情報・尺を取り、<video> でサムネイル（WebP）を作る。
 *   動画は変換しない。再生可否（playable）はサーバーがコーデック情報から判定する。
 * - SHA-256 はパートごとに増分計算する（hash-wasm。ファイル全体をメモリに載せない）。
 * - パートは 10MB ずつ順に送り、各パートを 3 回まで再試行する。complete も冪等なので再試行する。
 */
import { createSHA256 } from "hash-wasm";
import {
  MAX_VIDEO_SECONDS,
  MEDIA_MAX_BYTES,
  SNIFF_BYTES,
  UPLOAD_PART_SIZE,
  isVideoTooLong,
  kindOfMime,
  sniffMime,
  type MediaKind,
} from "../file-sniff";
import type { CompleteUploadInput, MediaDto, VideoCodecInfo } from "../services/media";

export const IMAGE_MAX_LONG_SIDE = 1920;
export const THUMBNAIL_LONG_SIDE = 640;
const RETRIES = 3;

export class UploadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UploadError";
  }
}

export type UploadProgress = { phase: "preparing" | "uploading" | "completing"; sentBytes: number; totalBytes: number };
export type UploadOptions = { onProgress?: (p: UploadProgress) => void; signal?: AbortSignal };

// ---------------------------------------------------------------- 画像

async function encodeCanvas(source: CanvasImageSource, width: number, height: number, quality: number): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new UploadError("画像を処理できませんでした");
  ctx.drawImage(source, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", quality));
  if (!blob) throw new UploadError("画像を処理できませんでした");
  return blob;
}

function fit(width: number, height: number, longSide: number) {
  const scale = Math.min(1, longSide / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** WebP・長辺 1920px 以下にする。EXIF の向きは反映する */
export async function prepareImage(file: Blob): Promise<{ blob: Blob; width: number; height: number }> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new UploadError("画像を読み込めませんでした");
  }
  try {
    const size = fit(bitmap.width, bitmap.height, IMAGE_MAX_LONG_SIDE);
    const blob = await encodeCanvas(bitmap, size.width, size.height, 0.9);
    if (blob.type !== "image/webp") throw new UploadError("このブラウザは WebP に変換できません。最新の Chrome をお使いください");
    return { blob, ...size };
  } finally {
    bitmap.close();
  }
}

// ---------------------------------------------------------------- mp4 の解析

type Box = { type: string; start: number; end: number; body: number };

async function readBytes(blob: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await blob.slice(start, end).arrayBuffer());
}

const fourcc = (b: Uint8Array, o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const u16 = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1];
const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) >>> 0) + ((b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]);
const u64 = (b: Uint8Array, o: number) => u32(b, o) * 2 ** 32 + u32(b, o + 4);

/** 先頭から順にトップレベルのボックスを見て moov を探す（moov が末尾にあるファイルにも対応） */
async function findTopLevel(file: Blob, type: string): Promise<{ start: number; end: number } | null> {
  let offset = 0;
  while (offset + 8 <= file.size) {
    const h = await readBytes(file, offset, offset + 16);
    let size = u32(h, 0);
    let header = 8;
    if (size === 1) {
      size = u64(h, 8);
      header = 16;
    } else if (size === 0) {
      size = file.size - offset;
    }
    if (size < header) return null;
    if (fourcc(h, 4) === type) return { start: offset + header, end: Math.min(file.size, offset + size) };
    offset += size;
  }
  return null;
}

function children(b: Uint8Array, start: number, end: number): Box[] {
  const boxes: Box[] = [];
  let o = start;
  while (o + 8 <= end) {
    let size = u32(b, o);
    let header = 8;
    if (size === 1) {
      size = u64(b, o + 8);
      header = 16;
    } else if (size === 0) {
      size = end - o;
    }
    if (size < header || o + size > end) break;
    boxes.push({ type: fourcc(b, o + 4), start: o, end: o + size, body: o + header });
    o += size;
  }
  return boxes;
}

const child = (b: Uint8Array, box: Box | undefined, type: string, skip = 0) =>
  box ? children(b, box.body + skip, box.end).find((c) => c.type === type) : undefined;

/** mvhd / mdhd の timescale と duration */
function timeOf(b: Uint8Array, box: Box): { timescale: number; duration: number } {
  const v = b[box.body];
  return v === 1
    ? { timescale: u32(b, box.body + 20), duration: u64(b, box.body + 24) }
    : { timescale: u32(b, box.body + 12), duration: u32(b, box.body + 16) };
}

/** H.264 SPS から chroma_format_idc と bit_depth を読む（High 系プロファイルのみ明示される） */
function parseAvcSps(nal: Uint8Array): { chromaFormat: VideoCodecInfo["chromaFormat"]; bitDepth: number | null } {
  // エミュレーション防止バイト（00 00 03）を取り除く
  const rbsp: number[] = [];
  for (let i = 1; i < nal.length; i++) {
    if (i >= 3 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0) continue;
    rbsp.push(nal[i]);
  }
  const profile = rbsp[0];
  let bit = 24; // profile_idc・constraint・level_idc の後
  const readBit = () => {
    const v = (rbsp[bit >> 3] >> (7 - (bit & 7))) & 1;
    bit++;
    return v;
  };
  const ue = () => {
    let zeros = 0;
    while (readBit() === 0 && zeros < 32) zeros++;
    let v = 0;
    for (let i = 0; i < zeros; i++) v = (v << 1) | readBit();
    return (1 << zeros) - 1 + v;
  };
  ue(); // seq_parameter_set_id
  if (![100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
    return { chromaFormat: "4:2:0", bitDepth: 8 };
  }
  const chroma = ue();
  if (chroma === 3) readBit(); // separate_colour_plane_flag
  const bitDepth = ue() + 8;
  const formats = ["4:0:0", "4:2:0", "4:2:2", "4:4:4"] as const;
  return { chromaFormat: formats[chroma] ?? null, bitDepth };
}

export type Mp4Info = { codecInfo: VideoCodecInfo; durationSeconds: number | null };

/** mp4 の moov から映像トラックのコーデック情報と尺を取る。映像トラックが無ければ null */
export async function parseMp4(file: Blob): Promise<Mp4Info | null> {
  const moovPos = await findTopLevel(file, "moov");
  if (!moovPos || moovPos.end - moovPos.start > 64 * 1024 * 1024) return null;
  const b = await readBytes(file, moovPos.start, moovPos.end);
  const top = children(b, 0, b.length);

  const mvhd = top.find((x) => x.type === "mvhd");
  let durationSeconds: number | null = null;
  if (mvhd) {
    const t = timeOf(b, mvhd);
    if (t.timescale > 0 && t.duration > 0) durationSeconds = t.duration / t.timescale;
  }

  for (const trak of top.filter((x) => x.type === "trak")) {
    const mdia = child(b, trak, "mdia");
    const hdlr = child(b, mdia, "hdlr");
    if (!hdlr || fourcc(b, hdlr.body + 8) !== "vide") continue;
    const mdhd = child(b, mdia, "mdhd");
    const stbl = child(b, child(b, mdia, "minf"), "stbl");
    const stsd = child(b, stbl, "stsd");
    if (!stsd) return null;
    // stsd: version/flags(4) + entry_count(4) の後に最初のサンプルエントリ
    const entry = children(b, stsd.body + 8, stsd.end)[0];
    if (!entry) return null;
    const codec = fourcc(b, entry.start + 4);
    const width = u16(b, entry.body + 24);
    const height = u16(b, entry.body + 26);

    let profile: number | null = null;
    let level: number | null = null;
    let chromaFormat: VideoCodecInfo["chromaFormat"] = null;
    let bitDepth: number | null = null;
    // VisualSampleEntry の固定部は 78 バイト。その後に avcC などの子ボックス
    const avcC = children(b, entry.body + 78, entry.end).find((c) => c.type === "avcC");
    if (avcC) {
      profile = b[avcC.body + 1];
      level = b[avcC.body + 3];
      const spsCount = b[avcC.body + 5] & 0x1f;
      if (spsCount > 0) {
        const spsLength = u16(b, avcC.body + 6);
        ({ chromaFormat, bitDepth } = parseAvcSps(b.subarray(avcC.body + 8, avcC.body + 8 + spsLength)));
      }
    }
    // H.265（HEVC）は hvcC の固定部から読む（ISO/IEC 14496-15 の HEVCDecoderConfigurationRecord。2026-09-25 から H.265 も通す）
    const hvcC = children(b, entry.body + 78, entry.end).find((c) => c.type === "hvcC");
    if (hvcC && hvcC.end - hvcC.body >= 19) {
      profile = b[hvcC.body + 1] & 0x1f;
      level = b[hvcC.body + 12];
      chromaFormat = (["4:0:0", "4:2:0", "4:2:2", "4:4:4"] as const)[b[hvcC.body + 16] & 0x03];
      bitDepth = (b[hvcC.body + 17] & 0x07) + 8;
    }

    let fps: number | null = null;
    const stts = child(b, stbl, "stts");
    if (mdhd && stts) {
      const t = timeOf(b, mdhd);
      const entries = u32(b, stts.body + 4);
      let samples = 0;
      for (let i = 0; i < entries; i++) samples += u32(b, stts.body + 8 + i * 8);
      if (t.timescale > 0 && t.duration > 0 && samples > 0) fps = Math.round((samples * t.timescale * 1000) / t.duration) / 1000;
    }

    return {
      codecInfo: { container: "mp4", codec, profile, level, width, height, fps, chromaFormat, bitDepth },
      durationSeconds,
    };
  }
  return null;
}

// ---------------------------------------------------------------- 動画のサムネイル

/** 1 秒目（短い動画は 1/10 の位置）のフレームを WebP にする。デコードできないブラウザでは null */
export async function videoThumbnail(file: Blob): Promise<{ blob: Blob | null; durationSeconds: number | null }> {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "auto";
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadeddata = () => resolve();
      video.onerror = () => reject(new Error("decode"));
      video.src = url;
    });
    const duration = Number.isFinite(video.duration) ? video.duration : null;
    await new Promise<void>((resolve) => {
      video.onseeked = () => resolve();
      video.currentTime = Math.min(1, (duration ?? 0) / 10);
    });
    const size = fit(video.videoWidth, video.videoHeight, THUMBNAIL_LONG_SIDE);
    const blob = await encodeCanvas(video, size.width, size.height, 0.8);
    return { blob: blob.type === "image/webp" ? blob : null, durationSeconds: duration };
  } catch {
    return { blob: null, durationSeconds: null };
  } finally {
    video.removeAttribute("src");
    video.load();
    URL.revokeObjectURL(url);
  }
}

// ---------------------------------------------------------------- 送信

type ApiError = { error?: { message?: string } };

/** 画面に出す文言。ステータスコードは出さず console にだけ残す（要件定義書 28 節） */
async function errorMessage(res: Response): Promise<string> {
  const body = (await res.json().catch(() => null)) as ApiError | null;
  console.error("upload request failed", res.status, res.url);
  if (body?.error?.message) return body.error.message;
  if (res.status === 413) return "ファイルが大きすぎます（動画は 12MB、画像は 20MB まで）";
  if (res.status === 415) return "この形式のファイルは使えません（JPEG・PNG・WebP・MP4）";
  return "アップロードに失敗しました。時間をおいてもう一度お試しください";
}

const retryable = (status: number) => status >= 500 || status === 408 || status === 429;

/** 通信失敗と 5xx・408・429 だけ再試行する（最初の 1 回 + 再試行 3 回） */
async function fetchWithRetry(input: string, init: () => RequestInit, signal?: AbortSignal): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try {
      const res = await fetch(input, { ...init(), signal });
      if (res.ok || !retryable(res.status) || attempt >= RETRIES) return res;
    } catch (e) {
      if (signal?.aborted || attempt >= RETRIES) throw e;
    }
    await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
  }
}

async function expectOk<T>(res: Response): Promise<T> {
  if (!res.ok) throw new UploadError(await errorMessage(res));
  return (await res.json()) as T;
}

/** 1 ファイルをアップロードし、作成された media を返す */
export async function uploadMedia(file: File, options: UploadOptions = {}): Promise<MediaDto> {
  const { onProgress, signal } = options;
  const mime = sniffMime(await readBytes(file, 0, SNIFF_BYTES));
  if (!mime) throw new UploadError("対応していない形式です（画像は JPEG・PNG・WebP、動画は MP4）");
  const kind: MediaKind = kindOfMime(mime);
  if (kind === "video" && file.size > MEDIA_MAX_BYTES.video) {
    throw new UploadError("動画は 12MB 以下にしてください（20 秒の 1920×1080 なら、書き出しのビットレートを 4Mbps 程度に）");
  }

  onProgress?.({ phase: "preparing", sentBytes: 0, totalBytes: file.size });
  let body: Blob = file;
  const meta: Omit<CompleteUploadInput, "sha256" | "parts"> = { name: file.name };
  let thumbnail: Blob | null = null;
  if (kind === "image") {
    const image = await prepareImage(file);
    body = image.blob;
    meta.width = image.width;
    meta.height = image.height;
    if (body.size > MEDIA_MAX_BYTES.image) throw new UploadError("画像は 20MB 以下にしてください");
  } else {
    const [info, thumb] = await Promise.all([parseMp4(file), videoThumbnail(file)]);
    meta.codecInfo = info?.codecInfo ?? null;
    meta.width = info?.codecInfo.width ?? null;
    meta.height = info?.codecInfo.height ?? null;
    meta.durationSeconds = info?.durationSeconds ?? thumb.durationSeconds;
    thumbnail = thumb.blob;
    if (meta.durationSeconds === null || meta.durationSeconds === undefined) {
      throw new UploadError("動画の長さを読み取れませんでした。MP4 の動画をお使いください");
    }
    if (isVideoTooLong(meta.durationSeconds)) {
      throw new UploadError(
        `動画は ${MAX_VIDEO_SECONDS} 秒以内にしてください（この動画は ${Math.round(meta.durationSeconds)} 秒です）`,
      );
    }
  }

  const { uploadId } = await expectOk<{ uploadId: string }>(
    await fetch("/api/media/uploads", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, size: body.size }),
      signal,
    }),
  );

  try {
    const hasher = await createSHA256();
    hasher.init();
    const parts: { partNumber: number; etag: string }[] = [];
    const partCount = Math.ceil(body.size / UPLOAD_PART_SIZE);
    for (let n = 1; n <= partCount; n++) {
      const chunk = new Uint8Array(await body.slice((n - 1) * UPLOAD_PART_SIZE, n * UPLOAD_PART_SIZE).arrayBuffer());
      hasher.update(chunk);
      const res = await fetchWithRetry(
        `/api/media/uploads/${uploadId}/parts/${n}`,
        () => ({ method: "PUT", headers: { "content-type": "application/octet-stream" }, body: chunk }),
        signal,
      );
      parts.push(await expectOk<{ partNumber: number; etag: string }>(res));
      onProgress?.({ phase: "uploading", sentBytes: Math.min(n * UPLOAD_PART_SIZE, body.size), totalBytes: body.size });
    }

    onProgress?.({ phase: "completing", sentBytes: body.size, totalBytes: body.size });
    const completeMeta: CompleteUploadInput = { ...meta, sha256: hasher.digest("hex"), parts };
    const res = await fetchWithRetry(
      `/api/media/uploads/${uploadId}/complete`,
      () => {
        const form = new FormData();
        form.set("meta", JSON.stringify(completeMeta));
        if (thumbnail) form.set("thumbnail", thumbnail, "thumbnail.webp");
        return { method: "POST", body: form };
      },
      signal,
    );
    return (await expectOk<{ media: MediaDto }>(res)).media;
  } catch (e) {
    // 中断は失敗しても構わない（残りは未完了アップロードの掃除が拾う）
    await fetch(`/api/media/uploads/${uploadId}`, { method: "DELETE" }).catch(() => undefined);
    throw e;
  }
}
