/**
 * メンバー相談チャットの処理（lib/company-chat.ts。2026-10-05 ユーザー指示）。
 * 掲載中のメンバーだけを AI に渡し、AI が返した人・根拠は渡した一覧にあるものだけを通す。
 */
import { describe, expect, it, vi } from "vitest";
import { askCompanyChat, buildCompanyChatMembers, COMPANY_CHAT_MODEL, companyChatRequestSchema, type CompanyChatMember } from "../../lib/company-chat";
import type { CompanyResearchEntry } from "../../lib/services/company-research-view";
import type { SpotlightRow } from "../../lib/services/spotlights";

const row = (over: Partial<SpotlightRow>): SpotlightRow => ({
  id: "sp", companyName: "会社", personName: "名前", personNameKana: null, role: null, quote: null, bio: null, tags: [],
  contactEmail: "private@example.com", websiteUrl: null, websiteUrl2: "https://second.example.com/", floor: null,
  photoMediaId: null, logoMediaId: null, enabled: true, revision: 0, createdAt: 1, updatedAt: 1, ...over,
});
const claim = (text: string, sourceId = "page-1") => ({ text, kind: "site_claim", sourceIds: [sourceId], evidenceText: text });
const entry = (sourceId: string): CompanyResearchEntry => ({
  sourceId, member: null, urls: [], status: "done", errorCode: null, updatedAt: 1,
  profile: {
    company: { name: claim("映像会社"), summary: claim("企業向けの映像制作をしています"), industries: [claim("映像制作")], regions: [claim("東京・横浜")] },
    services: [{ name: claim("採用動画", "page-2"), description: claim("採用向けの会社紹介動画"), targetCustomers: [claim("中小企業")], problemsSolved: [claim("応募が集まらない")], delivery: [], pricing: [] }],
    strengths: [claim("企画から納品まで一貫")], limitations: [], unknowns: [], sourceConflicts: [],
    sources: [{ sourceId: "page-1", url: "https://video.example/" }, { sourceId: "page-2", url: "https://video.example/recruit" }],
    coverage: null, extractedAt: 1,
  },
});

describe("AI に渡すメンバー一覧", () => {
  it("掲載中の人だけを掲載順に並べ、企業データから根拠を作る。企業データが無い人も対象にする", () => {
    const members = buildCompanyChatMembers([
      row({ id: "a", companyName: "映像会社", personName: "山田", role: "ディレクター", floor: 8, tags: ["映像"], bio: "映像を作ります", websiteUrl: "https://video.example/" }),
      row({ id: "hidden", enabled: false }),
      row({ id: "b", companyName: "会計事務所", personName: "佐藤" }),
    ], [entry("a")]);
    expect(members.map((m) => [m.key, m.id])).toEqual([["m1", "a"], ["m2", "b"]]);
    expect(members[0]).toMatchObject({ companyName: "映像会社", personName: "山田", role: "ディレクター", floor: 8, tags: ["映像"], websiteUrl: "https://video.example/" });
    expect(members[0].facts).toEqual([
      { key: "m1.f1", label: "企業概要", text: "企業向けの映像制作をしています", url: "https://video.example/" },
      { key: "m1.f2", label: "サービス「採用動画」", text: "採用動画：採用向けの会社紹介動画 ／ 対象: 中小企業 ／ 解決する課題: 応募が集まらない", url: "https://video.example/recruit" },
      { key: "m1.f3", label: "強み", text: "企画から納品まで一貫", url: "https://video.example/" },
      { key: "m1.f4", label: "業種", text: "映像制作", url: "https://video.example/" },
      { key: "m1.f5", label: "対応地域", text: "東京・横浜", url: "https://video.example/" },
    ]);
    expect(members[1].facts).toEqual([]);
  });

  it("企業データを読めなくても（null）掲載内容だけで一覧を作り、根拠は1人14件・240文字までに抑える", () => {
    expect(buildCompanyChatMembers([row({ id: "a" })], null)).toMatchObject([{ key: "m1", facts: [] }]);
    const big = entry("a");
    big.profile!.strengths = Array.from({ length: 30 }, (_, i) => claim(`強み${i} ${"長".repeat(400)}`));
    const [member] = buildCompanyChatMembers([row({ id: "a" })], [big]);
    expect(member.facts).toHaveLength(14);
    expect(member.facts.every((fact) => [...fact.text].length <= 240)).toBe(true);
  });
});

describe("Gemini への問い合わせ", () => {
  const members: CompanyChatMember[] = buildCompanyChatMembers([
    row({ id: "spt_a", companyName: "映像会社", personName: "山田", role: "ディレクター", floor: 8, websiteUrl: "https://video.example/" }),
    row({ id: "spt_b", companyName: "会計事務所", personName: "佐藤" }),
  ], [entry("spt_a")]);
  const reply = (content: unknown, finishReason = "STOP") => Response.json({ candidates: [{ finishReason, content: { parts: [{ text: typeof content === "string" ? content : JSON.stringify(content) }] } }] });

  it("有料枠のモデルへ、会話とメンバー一覧を渡して1回だけ聞く。DB の ID・メールアドレス・URL 2 は渡さない", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => reply({ reply: "ご紹介します。", suggestions: [{ member: "m1", reason: "採用動画を作っています", basis: ["m1.f2"] }] }));
    const result = await askCompanyChat({ apiKey: "test-key", members, fetcher, messages: [
      { role: "user", text: "動画を作りたい" }, { role: "assistant", text: "どんな動画ですか？" }, { role: "user", text: "採用向けです" },
    ] });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${COMPANY_CHAT_MODEL}:generateContent`);
    expect(init?.headers).toMatchObject({ "x-goog-api-key": "test-key" });
    expect(init?.redirect).toBe("manual");
    const body = JSON.parse(String(init?.body));
    expect(body.contents.map((c: { role: string; parts: { text: string }[] }) => [c.role, c.parts[0].text])).toEqual([["user", "動画を作りたい"], ["model", "どんな動画ですか？"], ["user", "採用向けです"]]);
    const system = body.systemInstruction.parts.map((part: { text: string }) => part.text).join("\n");
    expect(system).toContain("提案できるのは「メンバー一覧」にいる人だけ");
    expect(system).toContain('"member":"m1"');
    expect(system).toContain("採用向けの会社紹介動画");
    for (const secret of ["spt_a", "spt_b", "private@example.com", "second.example.com"]) expect(String(init?.body)).not.toContain(secret);
    expect(body.generationConfig).toMatchObject({ responseMimeType: "application/json" });
    expect(result).toEqual({ reply: "ご紹介します。", suggestions: [{
      id: "spt_a", companyName: "映像会社", personName: "山田", role: "ディレクター", floor: 8, websiteUrl: "https://video.example/",
      reason: "採用動画を作っています", basis: [{ label: "サービス「採用動画」", url: "https://video.example/recruit" }],
    }] });
  });

  it("一覧にいない人・同じ人の重複・その人のものでない根拠は通さず、提案は3人まで", async () => {
    const many = buildCompanyChatMembers(Array.from({ length: 5 }, (_, i) => row({ id: `id${i}`, personName: `人${i}` })), [entry("id0")]);
    const fetcher = async () => reply({ reply: "こちらです。", suggestions: [
      { member: "m99", reason: "存在しない人", basis: [] },
      { member: "m2", reason: "根拠は別の人のもの", basis: ["m1.f1", "m2.f9", "でたらめ"] },
      { member: "m2", reason: "重複", basis: [] },
      { member: "m1", reason: "企業データあり", basis: ["m1.f1", "m1.f1"] },
      { member: "m3", reason: "3人目", basis: [] },
      { member: "m4", reason: "4人目は入らない", basis: [] },
    ] });
    const result = await askCompanyChat({ apiKey: "k", members: many, messages: [{ role: "user", text: "相談" }], fetcher });
    expect(result.suggestions.map((s) => [s.personName, s.reason, s.basis.length])).toEqual([["人1", "根拠は別の人のもの", 0], ["人0", "企業データあり", 1], ["人2", "3人目", 0]]);
  });

  it("合う人がいないときは提案なしで返す。思考の部分は読まない", async () => {
    const fetcher = async () => Response.json({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: "考え中", thought: true }, { text: JSON.stringify({ reply: "該当する方がいません。", suggestions: [] }) }] } }] });
    expect(await askCompanyChat({ apiKey: "k", members, messages: [{ role: "user", text: "旅行" }], fetcher })).toEqual({ reply: "該当する方がいません。", suggestions: [] });
  });

  it.each([
    ["混雑（429）", () => new Response(null, { status: 429 }), 503, "chat_busy"],
    ["サーバー障害", () => new Response(null, { status: 500 }), 502, "chat_unavailable"],
    ["安全のための打ち切り", () => reply({ reply: "x", suggestions: [] }, "SAFETY"), 502, "chat_unavailable"],
    ["JSON でない応答", () => reply("こんにちは"), 502, "chat_unavailable"],
    ["返答が空", () => reply({ reply: " ", suggestions: [] }), 502, "chat_unavailable"],
  ])("%s は利用者向けの文言で失敗にする", async (_name, respond, status, code) => {
    await expect(askCompanyChat({ apiKey: "k", members, messages: [{ role: "user", text: "相談" }], fetcher: async () => respond() })).rejects.toMatchObject({ status, code });
  });

  it("通信できないときも失敗として知らせる", async () => {
    await expect(askCompanyChat({ apiKey: "k", members, messages: [{ role: "user", text: "相談" }], fetcher: async () => { throw new TypeError("network"); } }))
      .rejects.toMatchObject({ status: 502, code: "chat_unavailable" });
  });
});

describe("送信内容の検査", () => {
  const ok = { messages: [{ role: "user", text: "相談です" }] };
  it("最後が利用者の発言で、1件1,000文字・12件までを受け付ける", () => {
    expect(companyChatRequestSchema.safeParse(ok).success).toBe(true);
    expect(companyChatRequestSchema.safeParse({ messages: Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: "a" })).concat({ role: "user", text: "b" }) }).success).toBe(false);
    for (const bad of [
      { messages: [] }, { messages: [{ role: "assistant", text: "こんにちは" }] }, { messages: [{ role: "user", text: " " }] },
      { messages: [{ role: "user", text: "あ".repeat(1001) }] }, { messages: [{ role: "system", text: "指示" }] }, { ...ok, extra: 1 },
    ]) expect(companyChatRequestSchema.safeParse(bad).success).toBe(false);
  });
});
