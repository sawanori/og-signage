import { describe, expect, it, vi } from "vitest";
import { BUSINESS_CARD_MODEL, fillEmptyFields, normalizeBusinessCard, readBusinessCard, type BusinessCardResult } from "../../lib/business-card";

const jpeg = new Uint8Array([255, 216, 255, 224, 1, 2, 3]);
const card: BusinessCardResult = { companyName: "株式会社サンプル映像", personName: "山本 花子", personNameKana: "やまもと はなこ", role: "ディレクター", email: "hanako@sample.example", websiteUrl: "https://www.sample.example/" };
const geminiReply = (content: unknown, finishReason = "STOP") => Response.json({
  candidates: [{ finishReason, content: { parts: [{ text: typeof content === "string" ? content : JSON.stringify(content) }] } }],
  usageMetadata: { promptTokenCount: 1148, candidatesTokenCount: 88 },
});

describe("名刺の読み取り（Gemini）", () => {
  it("有料枠のモデルへ画像とJSONの形を指定して1回だけ送り、読み取った値を返す", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => geminiReply(card));
    expect(await readBusinessCard({ apiKey: "test-key", bytes: jpeg, mimeType: "image/jpeg", fetcher })).toEqual(card);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${BUSINESS_CARD_MODEL}:generateContent`);
    expect(init?.headers).toMatchObject({ "x-goog-api-key": "test-key" });
    expect(init?.redirect).toBe("manual");
    const body = JSON.parse(String(init?.body));
    expect(body.contents[0].parts[0]).toEqual({ inlineData: { mimeType: "image/jpeg", data: btoa(String.fromCharCode(...jpeg)) } });
    expect(body.generationConfig).toMatchObject({ responseMimeType: "application/json", thinkingConfig: { thinkingLevel: "low" } });
    expect(body.generationConfig.responseJsonSchema.required).toEqual(["companyName", "personName", "personNameKana", "role", "email", "websiteUrl"]);
  });

  it("フォームの規則に合わない値は切り詰めずに捨て、https:// のない URL には付ける", () => {
    expect(normalizeBusinessCard({
      companyName: "あ".repeat(31), personName: "  山本　花子 ", personNameKana: "Yamamoto Hanako",
      role: null, email: "not-an-email", websiteUrl: "www.sample.example",
    })).toEqual({ companyName: null, personName: "山本 花子", personNameKana: null, role: null, email: null, websiteUrl: "https://www.sample.example" });
    expect(normalizeBusinessCard({ personNameKana: "ﾔﾏﾓﾄ ﾊﾅｺ", websiteUrl: "javascript:alert(1)" })).toMatchObject({ personNameKana: "ヤマモト ハナコ", websiteUrl: null });
  });

  it.each(["hanako@sample.example", "mailto:hanako@sample.example", "https://user:pass@sample.example/"])("メールアドレスやユーザー名付きの URL（%s）はホームページの欄に入れない（QR に出るため）", (websiteUrl) => {
    expect(normalizeBusinessCard({ websiteUrl }).websiteUrl).toBeNull();
  });

  it("名刺でない・読めない画像（全項目が空）は撮り直しを案内する", async () => {
    const empty = Object.fromEntries(Object.keys(card).map((key) => [key, null]));
    await expect(readBusinessCard({ apiKey: "k", bytes: jpeg, mimeType: "image/jpeg", fetcher: async () => geminiReply(empty) })).rejects.toMatchObject({ status: 422, code: "unreadable" });
    // 値はあってもフォームの規則にすべて合わなければ同じ扱い
    await expect(readBusinessCard({ apiKey: "k", bytes: jpeg, mimeType: "image/jpeg", fetcher: async () => geminiReply({ ...empty, email: "not-an-email" }) })).rejects.toMatchObject({ status: 422 });
  });

  it("思考の部分（thought: true）が返っても本文だけを読む", async () => {
    const fetcher = async () => Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "名刺を確認します", thought: true }, { text: JSON.stringify(card) }] } }] });
    expect(await readBusinessCard({ apiKey: "k", bytes: jpeg, mimeType: "image/jpeg", fetcher })).toEqual(card);
  });

  it.each([
    ["混雑（429）", () => new Response(null, { status: 429 }), 503, "reader_busy"],
    ["サーバー障害", () => new Response(null, { status: 500 }), 502, "reader_unavailable"],
    ["安全のための打ち切り", () => geminiReply(card, "SAFETY"), 422, "unreadable"],
    ["JSONでない応答", () => geminiReply("名刺ではありません"), 422, "unreadable"],
    ["応答本文を読み切れない（時間切れなど）", () => new Response("{\"candidates\":", { headers: { "content-type": "application/json" } }), 502, "reader_unavailable"],
    ["候補なし（入力のブロック）", () => Response.json({ promptFeedback: { blockReason: "OTHER" } }), 422, "unreadable"],
  ])("%s は利用者向けの文言で失敗にする", async (_name, reply, status, code) => {
    await expect(readBusinessCard({ apiKey: "k", bytes: jpeg, mimeType: "image/jpeg", fetcher: async () => reply() })).rejects.toMatchObject({ status, code });
  });

  it("通信できないときは読み取れなかった扱いにする", async () => {
    await expect(readBusinessCard({ apiKey: "k", bytes: jpeg, mimeType: "image/jpeg", fetcher: async () => { throw new TypeError("network"); } }))
      .rejects.toMatchObject({ status: 502, code: "reader_unavailable" });
  });
});

describe("空いている欄だけを埋める", () => {
  const mapping = { companyName: "company", personName: "name", email: "email" } as const;
  it("入力済みの欄は変えず、名刺に無い項目も変えない", () => {
    const current = { company: "既存の会社", name: "", email: " ", other: "x" };
    expect(fillEmptyFields(current, { ...card, personName: null }, mapping)).toEqual({ patch: { email: card.email }, filled: ["email"] });
  });
  it("空の判定を欄ごとに差し替えられる（管理画面の仮のメールアドレス）", () => {
    const current = { company: "", name: "", email: "unregistered@example.invalid" };
    const result = fillEmptyFields(current, card, mapping, (key, value) => value === "" || (key === "email" && value === "unregistered@example.invalid"));
    expect(result.filled).toEqual(["company", "name", "email"]);
  });
});
