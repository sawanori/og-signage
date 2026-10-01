import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUSINESS_CARD_MAX_BODY_BYTES } from "../../lib/business-card";

const { POST } = await import("../../app/api/business-card/route");
const BASE = "https://signage.example.com";
const jpeg = new Uint8Array([255, 216, 255, 224, 1, 2, 3]);
const reading = { companyName: "株式会社サンプル映像", personName: "山本 花子", personNameKana: null, role: null, email: "hanako@sample.example", websiteUrl: null };

function cardForm(bytes: Uint8Array = jpeg, extra?: [string, string]) {
  const body = new FormData();
  body.append("card", new Blob([bytes as BlobPart], { type: "image/jpeg" }), "card");
  if (extra) body.append(...extra);
  return body;
}
function request(body: BodyInit = cardForm(), headers: Record<string, string> = {}) {
  return new Request(`${BASE}/api/business-card`, { method: "POST", headers: { origin: BASE, "cf-connecting-ip": "192.0.2.1", ...headers }, body });
}
const gemini = () => vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(reading) }] } }] }));

beforeEach(() => { env.GEMINI_API_KEY = "test-key"; });
afterEach(() => {
  vi.restoreAllMocks();
  env.GEMINI_API_KEY = undefined;
  env.BUSINESS_CARD_RATE_LIMITER = { limit: async () => ({ success: true }) };
});

describe("POST /api/business-card", () => {
  it("ログインなしで名刺を読み取り、保存せず no-store で値だけを返す", async () => {
    const fetch = gemini();
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ data: reading });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0][0])).toContain("generativelanguage.googleapis.com");
  });

  it("別のサイトからの送信は読み取らない", async () => {
    const fetch = gemini();
    expect((await POST(request(cardForm(), { origin: "https://evil.example" }))).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("回数制限を超えたら Gemini を呼ばずに 429 を返す", async () => {
    const fetch = gemini();
    env.BUSINESS_CARD_RATE_LIMITER = { limit: async () => ({ success: false }) };
    const response = await POST(request());
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("API キーが未設定なら 503 で手入力を案内する", async () => {
    env.GEMINI_API_KEY = undefined;
    const response = await POST(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "reader_not_configured" } });
  });

  it.each([
    ["画像以外", cardForm(new TextEncoder().encode("not an image"))],
    ["余分な項目", cardForm(jpeg, ["data", "{}"])],
    ["multipart でない本文", JSON.stringify({ card: "x" })],
  ])("%s は 400 にして Gemini を呼ばない", async (_name, body) => {
    const fetch = gemini();
    expect((await POST(request(body))).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("上限より大きい本文は読み切る前に 413 にする", async () => {
    const fetch = gemini();
    const big = new Uint8Array(BUSINESS_CARD_MAX_BODY_BYTES + 1);
    big.set(jpeg);
    expect((await POST(request(cardForm(big)))).status).toBe(413);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("Gemini の障害は利用者向けの文言で返す", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 500 }));
    const response = await POST(request());
    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: { code: "reader_unavailable" } });
  });
});
