/**
 * POST /api/chat — メンバー相談チャット（2026-10-05 ユーザー指示。試験運用）。
 * 許可したアカウントだけが使え、相談の内容は保存もログ出力もしない。
 */
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../db/index";
import { memberSpotlights, users } from "../../db/schema";
import { openTempDb } from "../helpers/temp-db";

const state = vi.hoisted(() => ({ db: null as unknown as Db, session: null as unknown }));
vi.mock("../../lib/runtime", () => ({ getDb: () => state.db }));
vi.mock("../../lib/auth", async (original) => {
  const actual = await original<typeof import("../../lib/auth")>();
  const deps = () => ({ db: state.db, getSession: async () => state.session });
  return { ...actual, withRole: <C>(role: "staff" | "administrator", handler: (request: Request, context: C, user: import("../../lib/auth").AuthUser) => Promise<Response>) => actual.withRole(role, handler, deps) };
});
const { POST } = await import("../../app/api/chat/route");

const BASE = "https://signage.example.com";
const SECRET_QUESTION = "社外秘の新規事業について、採用動画を作りたい";
let close: () => void;
const request = (body: unknown = { messages: [{ role: "user", text: SECRET_QUESTION }] }, raw?: string) =>
  new Request(`${BASE}/api/chat`, { method: "POST", headers: { origin: BASE, "content-type": "application/json" }, body: raw ?? JSON.stringify(body) });
const gemini = (output: unknown = { reply: "ご紹介します。", suggestions: [{ member: "m1", reason: "採用動画を作っています", basis: ["m1.f1"] }] }) =>
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(output) }] } }] }));
const research = () => ({ fetch: vi.fn(async () => Response.json({ data: [{
  sourceId: "spt_video", lastSuccessfulCrawlAt: 1,
  job: { status: "succeeded", phase: "complete", lastErrorCode: null, updatedAt: 1, urls: [{ slot: 1, url: "https://video.example/" }] },
  profile: { extractedAt: 1, createdAt: 1, payload: {
    company: { name: null, summary: { text: "企業向けの映像制作", kind: "site_claim", sourceIds: ["p1"], evidenceText: "x" }, industries: [], regions: [] },
    services: [], strengths: [], limitations: [], unknowns: [], sourceConflicts: [], sources: [{ sourceId: "p1", url: "https://video.example/about" }], coverage: null,
  } },
}] })) });

beforeEach(async () => {
  const opened = await openTempDb();
  state.db = opened.db; close = opened.close;
  await state.db.insert(users).values([
    { id: "viewer", email: "viewer@example.com", role: "staff" },
    { id: "other", email: "other-admin@example.com", role: "administrator" },
  ]);
  await state.db.insert(memberSpotlights).values([
    { id: "spt_video", companyName: "映像会社", personName: "山田", role: "ディレクター", floor: 8, websiteUrl: "https://video.example/", createdAt: 100 },
    { id: "spt_hidden", companyName: "非表示の会社", personName: "非表示", enabled: false, createdAt: 200 },
  ]);
  state.session = { userId: "viewer", sessionVersion: 0 };
  env.GEMINI_API_KEY = "test-key";
  env.COMPANY_RESEARCH = research();
});
afterEach(() => {
  vi.restoreAllMocks();
  env.GEMINI_API_KEY = undefined;
  env.COMPANY_RESEARCH = undefined;
  env.COMPANY_CHAT_RATE_LIMITER = { limit: async () => ({ success: true }) };
  close();
});

describe("POST /api/chat", () => {
  it("許可したアカウントの相談に、掲載中のメンバーから提案を返す。相談の内容は保存もログ出力もしない", async () => {
    const fetch = gemini();
    const logs = ["log", "info", "warn", "error"].map((level) => vi.spyOn(console, level as "log").mockImplementation(() => {}));
    const before = JSON.stringify(await state.db.select().from(memberSpotlights));
    const response = await POST(request(), undefined as never);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ data: { reply: "ご紹介します。", suggestions: [{
      id: "spt_video", companyName: "映像会社", personName: "山田", role: "ディレクター", floor: 8, websiteUrl: "https://video.example/",
      reason: "採用動画を作っています", basis: [{ label: "企業概要", url: "https://video.example/about" }],
    }] } });
    // AI には掲載中の人だけを渡す
    const sent = String(fetch.mock.calls[0][1]?.body);
    expect(sent).toContain("映像会社");
    expect(sent).not.toContain("非表示の会社");
    expect(JSON.stringify(await state.db.select().from(memberSpotlights))).toBe(before);
    for (const log of logs) expect(JSON.stringify(log.mock.calls)).not.toContain("社外秘");
  });

  it("ログインしていなければ 401、許可していないアカウント（管理者でも）は 404 で、AI も企業データも呼ばない", async () => {
    const fetch = gemini();
    state.session = null;
    expect((await POST(request(), undefined as never)).status).toBe(401);
    state.session = { userId: "other", sessionVersion: 0 };
    expect((await POST(request(), undefined as never)).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
    expect(env.COMPANY_RESEARCH!.fetch).not.toHaveBeenCalled();
  });

  it("回数制限を超えたら AI を呼ばずに 429、API キーが無ければ 503", async () => {
    const fetch = gemini();
    env.COMPANY_CHAT_RATE_LIMITER = { limit: async () => ({ success: false }) };
    const limited = await POST(request(), undefined as never);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBe("60");
    env.COMPANY_CHAT_RATE_LIMITER = { limit: async () => ({ success: true }) };
    env.GEMINI_API_KEY = undefined;
    expect((await POST(request(), undefined as never)).status).toBe(503);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["JSON でない本文", undefined, "{broken"],
    ["最後が AI の発言", { messages: [{ role: "assistant", text: "こんにちは" }] }, undefined],
    ["長すぎる相談", { messages: [{ role: "user", text: "あ".repeat(1001) }] }, undefined],
    ["余分な項目", { messages: [{ role: "user", text: "相談" }], model: "other" }, undefined],
  ])("%s は 400 にして AI を呼ばない", async (_name, body, raw) => {
    const fetch = gemini();
    expect((await POST(request(body, raw), undefined as never)).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("大きすぎる本文は 413 にする", async () => {
    const fetch = gemini();
    expect((await POST(request(undefined, JSON.stringify({ messages: [{ role: "user", text: "相談" }], pad: "x".repeat(70_000) })), undefined as never)).status).toBe(413);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("企業データを読めなくても、掲載内容だけで提案する", async () => {
    env.COMPANY_RESEARCH = undefined;
    gemini({ reply: "ご紹介します。", suggestions: [{ member: "m1", reason: "ディレクターです", basis: ["m1.f1"] }] });
    const response = await POST(request(), undefined as never);
    expect(response.status).toBe(200);
    expect((await response.json()).data.suggestions).toMatchObject([{ personName: "山田", basis: [] }]);
  });

  it("AI の障害は利用者向けの文言で返す", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 500 }));
    const response = await POST(request(), undefined as never);
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "chat_unavailable" } });
  });
});
