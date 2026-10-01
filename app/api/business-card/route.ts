/**
 * POST /api/business-card — 名刺の画像を読み取り、入力欄に入れる文字を返す（本人登録と管理画面の両方から使う）。
 * 本人登録はログイン不要なので、Origin の確認と IP ごとの回数制限で外からの連打による課金を防ぐ。
 * 画像は読み取りに使うだけで、保存もログ出力もしない。
 */
import { env } from "cloudflare:workers";
import { BUSINESS_CARD_MAX_BODY_BYTES, BUSINESS_CARD_RETRY_AFTER_SECONDS, BusinessCardError, readBusinessCard } from "@/lib/business-card";
import { checkCsrf } from "@/lib/csrf";
import { SNIFF_BYTES, sniffMime } from "@/lib/file-sniff";
import { readLimitedFormData } from "@/lib/read-limited-form";

const INVALID = new BusinessCardError(400, "invalid_input", "名刺の画像をJPEG・PNG・WebPで選んでください");
const TOO_LARGE = new BusinessCardError(413, "body_too_large", "名刺の画像が大きすぎます。別の画像をお選びください");

export async function POST(request: Request): Promise<Response> {
  const forbidden = checkCsrf(request);
  if (forbidden) return forbidden;
  try {
    const allowed = await env.BUSINESS_CARD_RATE_LIMITER.limit({ key: request.headers.get("cf-connecting-ip") ?? "unknown" });
    if (!allowed.success) {
      return Response.json({ error: { code: "rate_limited", message: "名刺の読み取りが続いています。60秒後にもう一度お試しください" } },
        { status: 429, headers: { "retry-after": String(BUSINESS_CARD_RETRY_AFTER_SECONDS) } });
    }
    if (!env.GEMINI_API_KEY) throw new BusinessCardError(503, "reader_not_configured", "名刺の読み取りは現在使えません。お手数ですが手で入力してください");
    const form = await readLimitedFormData(request, BUSINESS_CARD_MAX_BODY_BYTES, { tooLarge: () => TOO_LARGE, invalid: () => INVALID });
    const keys = [...form.keys()];
    const card = form.get("card");
    if (keys.length !== 1 || keys[0] !== "card" || card === null || typeof card === "string") throw INVALID;
    const bytes = new Uint8Array(await card.arrayBuffer());
    const mimeType = sniffMime(bytes.subarray(0, SNIFF_BYTES));
    if (!mimeType || mimeType === "video/mp4") throw INVALID;
    const result = await readBusinessCard({ apiKey: env.GEMINI_API_KEY, bytes, mimeType });
    return Response.json({ data: result }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    const known = error instanceof BusinessCardError ? error : new BusinessCardError(502, "reader_unavailable", "名刺を読み取れませんでした。時間をおいてもう一度お試しください");
    return Response.json({ error: { code: known.code, message: known.message } }, { status: known.status, headers: { "cache-control": "no-store" } });
  }
}
