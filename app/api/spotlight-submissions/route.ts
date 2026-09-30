import { env } from "cloudflare:workers";
import { checkCsrf } from "@/lib/csrf";
import { getMediaBucket } from "@/lib/r2";
import { getDb } from "@/lib/runtime";
import { SpotlightSubmissionError, submitSpotlightSubmission, type SpotlightSubmissionImages } from "@/lib/services/spotlight-submissions";
import { SPOTLIGHT_SUBMISSION_MAX_BODY_BYTES, SPOTLIGHT_SUBMISSION_MAX_DATA_BYTES, SPOTLIGHT_SUBMISSION_RETRY_AFTER_SECONDS } from "@/lib/spotlight-submissions";

function invalidInput(message = "送信内容が正しくありません"): never {
  throw new SpotlightSubmissionError(400, "invalid_input", message);
}

async function readForm(request: Request): Promise<FormData> {
  const length = request.headers.get("content-length");
  if (length !== null && Number(length) > SPOTLIGHT_SUBMISSION_MAX_BODY_BYTES) throw new SpotlightSubmissionError(413, "body_too_large", "送信内容は5MiBまでです");
  const contentType = request.headers.get("content-type");
  if (!contentType?.toLowerCase().startsWith("multipart/form-data;") || !request.body) invalidInput();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > SPOTLIGHT_SUBMISSION_MAX_BODY_BYTES) {
        await reader.cancel();
        throw new SpotlightSubmissionError(413, "body_too_large", "送信内容は5MiBまでです");
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    return await new Request(request.url, { method: "POST", headers: { "content-type": contentType }, body: bytes }).formData();
  } catch { return invalidInput(); }
}

export async function POST(request: Request): Promise<Response> {
  const forbidden = checkCsrf(request);
  if (forbidden) return forbidden;
  try {
    const allowed = await env.SPOTLIGHT_SUBMISSION_RATE_LIMITER.limit({ key: request.headers.get("cf-connecting-ip") ?? "unknown" });
    if (!allowed.success) return Response.json({ error: { code: "rate_limited", message: "送信が集中しています。60秒後にもう一度お試しください" } }, { status: 429, headers: { "retry-after": String(SPOTLIGHT_SUBMISSION_RETRY_AFTER_SECONDS) } });
    const form = await readForm(request);
    const seen = new Set<string>();
    for (const [key] of form) {
      if (!["data", "photo", "logo"].includes(key) || seen.has(key)) invalidInput();
      seen.add(key);
    }
    const data = form.get("data");
    if (typeof data !== "string") invalidInput();
    if (new TextEncoder().encode(data).byteLength > SPOTLIGHT_SUBMISSION_MAX_DATA_BYTES) throw new SpotlightSubmissionError(413, "data_too_large", "入力内容が長すぎます");
    let input: unknown;
    try { input = JSON.parse(data); } catch { invalidInput(); }
    const images: SpotlightSubmissionImages = {};
    for (const kind of ["photo", "logo"] as const) {
      const file = form.get(kind);
      if (file === null) continue;
      if (typeof file === "string") invalidInput();
      images[kind] = { bytes: new Uint8Array(await file.arrayBuffer()), mimeType: file.type };
    }
    const result = await submitSpotlightSubmission(getDb(), getMediaBucket(), input, images);
    return Response.json({ data: result }, { status: 202, headers: { "cache-control": "no-store" } });
  } catch (error) {
    if (error instanceof SpotlightSubmissionError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status });
    // DB/R2へ届いたか不明な失敗を保存前の拒否に変換しない。
    return Response.json({ error: { code: "temporarily_unavailable", message: "送信結果を確認できません。画面を閉じずに、時間をおいて同じ内容で再確認してください" } }, { status: 503 });
  }
}
