// @vitest-environment jsdom
/**
 * メンバー相談チャットの画面（/chat。2026-10-05 ユーザー指示。試験運用）。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanyChat } from "@/components/chat/company-chat";

const suggestion = {
  id: "spt_video", companyName: "映像会社", personName: "山田", role: "ディレクター", floor: 8, websiteUrl: "https://video.example/",
  reason: "採用動画を作っています", basis: [{ label: "サービス「採用動画」", url: "https://video.example/recruit" }, { label: "強み", url: null }],
};
const answer = (data: unknown, status = 200) => Response.json(status === 200 ? { data } : data, { status });
const type = (text: string) => fireEvent.change(screen.getByLabelText("相談したいこと"), { target: { value: text } });
const sendButton = () => screen.getByRole("button", { name: "相談する" }) as HTMLButtonElement;

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("メンバー相談チャット", () => {
  it("相談を送ると、返答と提案のカード（名前・階・理由・根拠・ホームページ）を出す", async () => {
    const fetchMock = vi.fn(async () => answer({ reply: "ご紹介します。", suggestions: [suggestion] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<CompanyChat />);
    expect(sendButton().disabled).toBe(true);
    type(" 採用動画を作りたい ");
    fireEvent.click(sendButton());
    expect(await screen.findByText("ご紹介します。")).toBeTruthy();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/chat");
    expect(JSON.parse(String(init.body))).toEqual({ messages: [{ role: "user", text: "採用動画を作りたい" }] });
    const card = within(screen.getByRole("article", { name: "山田 さんの提案" }));
    expect(card.getByText("8階")).toBeTruthy();
    // 会社名と肩書きは全角の空白で区切って1行に出す（検索の仕組みが空白をそろえるので、ここでは半角で探す）
    expect(card.getByText("映像会社 ディレクター")).toBeTruthy();
    expect(card.getByText("採用動画を作っています")).toBeTruthy();
    const basis = card.getByRole("link", { name: "サービス「採用動画」" }) as HTMLAnchorElement;
    expect(basis.getAttribute("href")).toBe("https://video.example/recruit");
    expect(basis.target).toBe("_blank");
    expect(basis.rel).toBe("noreferrer noopener");
    expect(card.getByText("強み").closest("a")).toBeNull();
    expect((card.getByRole("link", { name: "ホームページを見る" }) as HTMLAnchorElement).getAttribute("href")).toBe("https://video.example/");
    expect((screen.getByLabelText("相談したいこと") as HTMLTextAreaElement).value).toBe("");
  });

  it("続けて相談すると、それまでの会話（提案した人の名前つき）も一緒に送る", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(answer({ reply: "ご紹介します。", suggestions: [suggestion] }))
      .mockResolvedValueOnce(answer({ reply: "8階にいらっしゃいます。", suggestions: [] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<CompanyChat />);
    type("採用動画を作りたい"); fireEvent.click(sendButton());
    await screen.findByText("ご紹介します。");
    type("どこにいますか？"); fireEvent.click(sendButton());
    await screen.findByText("8階にいらっしゃいます。");
    expect(JSON.parse(String((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body))).toEqual({ messages: [
      { role: "user", text: "採用動画を作りたい" },
      { role: "assistant", text: "ご紹介します。\n（提案した人: 映像会社 山田）" },
      { role: "user", text: "どこにいますか？" },
    ] });
  });

  it("例の相談を押すと、そのまま送る。http/https 以外のリンクは出さない", async () => {
    const fetchMock = vi.fn(async () => answer({ reply: "こちらです。", suggestions: [{ ...suggestion, websiteUrl: "javascript:alert(1)", basis: [{ label: "企業概要", url: "javascript:alert(1)" }] }] }));
    vi.stubGlobal("fetch", fetchMock);
    render(<CompanyChat />);
    fireEvent.click(screen.getByRole("button", { name: "採用向けの会社紹介動画を作りたい" }));
    await screen.findByText("こちらです。");
    expect(screen.queryAllByRole("link")).toHaveLength(0);
    expect(screen.getByText("企業概要")).toBeTruthy();
  });

  it("送れなかったときは理由を出し、相談を入力欄に戻して送り直せるようにする", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(answer({ error: { code: "rate_limited", message: "相談が続いています。60秒後にもう一度お試しください" } }, 429))
      .mockRejectedValueOnce(new TypeError("network"));
    vi.stubGlobal("fetch", fetchMock);
    render(<CompanyChat />);
    type("採用動画を作りたい"); fireEvent.click(sendButton());
    expect((await screen.findByRole("alert")).textContent).toBe("相談が続いています。60秒後にもう一度お試しください");
    expect((screen.getByLabelText("相談したいこと") as HTMLTextAreaElement).value).toBe("採用動画を作りたい");
    expect(screen.queryByText("メンバーを探しています…")).toBeNull();
    fireEvent.click(sendButton());
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("うまく送れませんでした。通信状況を確認して、もう一度お試しください。"));
    // 失敗した相談は会話に残さない（次に送るとき、同じ相談が二重にならない）
    expect(JSON.parse(String((fetchMock.mock.calls[1] as unknown as [string, RequestInit])[1].body))).toEqual({ messages: [{ role: "user", text: "採用動画を作りたい" }] });
  });

  it("1,000文字を超える相談は送れない。相談の内容を保存しないことを画面に書く", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<CompanyChat />);
    type("あ".repeat(1001));
    expect(sendButton().disabled).toBe(true);
    expect(screen.getByText("1001 / 1000文字")).toBeTruthy();
    expect(screen.getByText(/相談の内容は保存しません。/)).toBeTruthy();
    expect(screen.getByText("試験運用")).toBeTruthy();
  });
});
