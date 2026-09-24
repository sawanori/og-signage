/**
 * R2（MEDIA_BUCKET）の操作と、本文をそのまま返す中継。
 *
 * - サービス層は MediaBucket（R2Bucket のうち使う分）にだけ依存する。テストはメモリ上の偽物を渡す。
 * - 中継は R2 の本文ストリームをそのまま Response に渡す（JS で読み直さない。docs/spikes/workers.md 5 節）。
 *   Range はここで解釈し、範囲外は 416 を返す（R2 に範囲外を渡すと例外になるため）。
 */
import { env } from "cloudflare:workers";

export type R2Range = { offset: number; length: number } | { suffix: number };

export interface R2ObjectInfo {
  size: number;
  httpEtag: string;
}

export interface R2ObjectWithBody extends R2ObjectInfo {
  body: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export type R2Part = { partNumber: number; etag: string };

export interface R2Multipart {
  readonly key: string;
  readonly uploadId: string;
  uploadPart(partNumber: number, value: ReadableStream<Uint8Array> | Uint8Array): Promise<R2Part>;
  abort(): Promise<void>;
  complete(parts: R2Part[]): Promise<R2ObjectInfo>;
}

type PutOptions = { httpMetadata?: { contentType?: string } };

export interface MediaBucket {
  createMultipartUpload(key: string, options?: PutOptions): Promise<R2Multipart>;
  resumeMultipartUpload(key: string, uploadId: string): R2Multipart;
  head(key: string): Promise<R2ObjectInfo | null>;
  get(key: string, options?: { range?: R2Range }): Promise<R2ObjectWithBody | null>;
  put(key: string, value: Uint8Array, options?: PutOptions): Promise<R2ObjectInfo | null>;
  delete(keys: string | string[]): Promise<void>;
}

/** wrangler.jsonc の r2_buckets（MEDIA_BUCKET） */
export function getMediaBucket(): MediaBucket {
  return (env as unknown as { MEDIA_BUCKET: MediaBucket }).MEDIA_BUCKET;
}

/** キーはサーバーが決める。クライアントの指定は受けない */
export const mediaKeys = (uploadId: string) => ({
  original: `media/${uploadId}/original`,
  thumbnail: `media/${uploadId}/thumbnail`,
});

// ---------------------------------------------------------------- Range と中継

export type RangeResult =
  | { kind: "full" }
  | { kind: "partial"; offset: number; length: number }
  | { kind: "unsatisfiable" };

/**
 * `Range: bytes=a-b` / `bytes=a-` / `bytes=-n` を解釈する。
 * 複数範囲・書式違い・単位違いは Range なしとして全体を返す（RFC 9110 で許される）。
 */
export function parseRange(header: string | null, size: number): RangeResult {
  if (!header) return { kind: "full" };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return { kind: "full" };

  if (m[1] === "") {
    const suffix = Number(m[2]);
    if (suffix === 0 || size === 0) return { kind: "unsatisfiable" };
    const offset = Math.max(0, size - suffix);
    return { kind: "partial", offset, length: size - offset };
  }
  const start = Number(m[1]);
  if (start >= size) return { kind: "unsatisfiable" };
  const end = m[2] === "" ? size - 1 : Math.min(Number(m[2]), size - 1);
  if (end < start) return { kind: "full" };
  return { kind: "partial", offset: start, length: end - start + 1 };
}

export type ServeTarget = { key: string; size: number; contentType: string };

/**
 * R2 の本文を加工せずに返す。Content-Type は検査済みの値、nosniff 付き。
 * GET と HEAD だけ。R2 に本体が無ければ 404。
 */
export async function serveObject(bucket: MediaBucket, request: Request, target: ServeTarget): Promise<Response> {
  const headers = new Headers({
    "content-type": target.contentType,
    "x-content-type-options": "nosniff",
    "accept-ranges": "bytes",
    "cache-control": "private, no-cache",
  });
  const range = parseRange(request.headers.get("range"), target.size);

  if (range.kind === "unsatisfiable") {
    headers.set("content-range", `bytes */${target.size}`);
    return new Response(null, { status: 416, headers });
  }

  const isHead = request.method === "HEAD";
  const obj = isHead
    ? await bucket.head(target.key)
    : await bucket.get(target.key, range.kind === "partial" ? { range: { offset: range.offset, length: range.length } } : undefined);
  if (!obj) return Response.json({ error: { code: "not_found", message: "ファイルが見つかりません" } }, { status: 404 });

  headers.set("etag", obj.httpEtag);
  const body = isHead ? null : (obj as R2ObjectWithBody).body;
  if (range.kind === "partial") {
    headers.set("content-range", `bytes ${range.offset}-${range.offset + range.length - 1}/${obj.size}`);
    headers.set("content-length", String(range.length));
    return new Response(body, { status: 206, headers });
  }
  headers.set("content-length", String(obj.size));
  return new Response(body, { status: 200, headers });
}
