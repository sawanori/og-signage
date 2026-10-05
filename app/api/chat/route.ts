/**
 * POST /api/chat — メンバー相談チャット（2026-10-05 ユーザー指示。試験運用）。
 * ログインしていて、COMPANY_CHAT_EMAILS に入っているアカウントだけが使える。それ以外にはあることも知らせない（404）。
 * 相談の内容は保存もログ出力もしない。掲載中のメンバーの情報と企業データを読むだけで、どこにも書かない。
 */
import { env } from "cloudflare:workers";
import { withRole } from "@/lib/auth";
import {
  askCompanyChat, buildCompanyChatMembers, COMPANY_CHAT_MAX_BODY_BYTES, COMPANY_CHAT_RETRY_AFTER_SECONDS,
  CompanyChatError, companyChatRequestSchema,
} from "@/lib/company-chat";
import { canUseCompanyChat } from "@/lib/company-chat-access";
import { getDb } from "@/lib/runtime";
import { loadCompanyResearch } from "@/lib/services/company-research-view";
import { listSpotlights } from "@/lib/services/spotlights";

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });

export const POST = withRole("staff", async (request: Request, _context: unknown, user) => {
  if (!canUseCompanyChat(user.email, env.COMPANY_CHAT_EMAILS)) return json(404, { error: { code: "not_found", message: "見つかりません" } });
  try {
    const allowed = await env.COMPANY_CHAT_RATE_LIMITER.limit({ key: user.id });
    if (!allowed.success) {
      return json(429, { error: { code: "rate_limited", message: "相談が続いています。60秒後にもう一度お試しください" } }, { "retry-after": String(COMPANY_CHAT_RETRY_AFTER_SECONDS) });
    }
    if (!env.GEMINI_API_KEY) throw new CompanyChatError(503, "chat_not_configured", "相談チャットは現在使えません");
    const length = Number(request.headers.get("content-length") ?? "0");
    if (length > COMPANY_CHAT_MAX_BODY_BYTES) throw new CompanyChatError(413, "body_too_large", "相談の文章が長すぎます");
    let raw: unknown;
    try {
      const text = await request.text();
      if (new TextEncoder().encode(text).byteLength > COMPANY_CHAT_MAX_BODY_BYTES) throw new CompanyChatError(413, "body_too_large", "相談の文章が長すぎます");
      raw = JSON.parse(text);
    } catch (error) {
      if (error instanceof CompanyChatError) throw error;
      throw new CompanyChatError(400, "invalid_input", "送信内容が正しくありません");
    }
    const parsed = companyChatRequestSchema.safeParse(raw);
    if (!parsed.success) throw new CompanyChatError(400, "invalid_input", "相談は1,000文字以内で入力してください");
    const db = getDb();
    // 企業データを読めなくても、掲載中のメンバーの肩書き・紹介文・タグだけで提案する
    const [rows, entries] = await Promise.all([listSpotlights(db), loadCompanyResearch(db, env.COMPANY_RESEARCH)]);
    const members = buildCompanyChatMembers(rows, entries);
    const result = await askCompanyChat({ apiKey: env.GEMINI_API_KEY, members, messages: parsed.data.messages });
    return json(200, { data: result });
  } catch (error) {
    const known = error instanceof CompanyChatError ? error : new CompanyChatError(502, "chat_unavailable", "うまく答えられませんでした。時間をおいてもう一度お試しください");
    return json(known.status, { error: { code: known.code, message: known.message } });
  }
});
