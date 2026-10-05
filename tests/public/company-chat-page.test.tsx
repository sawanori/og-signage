/**
 * メンバー相談チャットの入口（/chat）。許可したアカウントだけが開け、それ以外にはあることも知らせない。
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuthzError } from "@/lib/auth";

const state = vi.hoisted(() => ({ email: "viewer@example.com" as string | null }));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  redirect: (url: string) => { throw new Error(`NEXT_REDIRECT ${url}`); },
}));
vi.mock("@/lib/auth", async (original) => ({
  ...await original<typeof import("@/lib/auth")>(),
  requireUser: async () => {
    if (state.email === null) throw new AuthzError(401);
    return { id: "u", email: state.email, name: null, role: "administrator" };
  },
}));
vi.mock("@/components/chat/company-chat", () => ({ CompanyChat: () => <div>chat-screen</div> }));

const { default: CompanyChatPage, metadata } = await import("@/app/chat/page");

afterEach(() => { state.email = "viewer@example.com"; });

describe("メンバー相談チャットの入口", () => {
  it("許可したアカウントには画面を出し、検索に載せない", async () => {
    expect(renderToStaticMarkup(await CompanyChatPage())).toContain("chat-screen");
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
  it("許可していないアカウント（管理者でも）は 404", async () => {
    state.email = "other-admin@example.com";
    await expect(CompanyChatPage()).rejects.toThrow("NEXT_NOT_FOUND");
  });
  it("ログインしていなければログイン画面へ送り、ログイン後はこの画面へ戻す", async () => {
    state.email = null;
    await expect(CompanyChatPage()).rejects.toThrow("NEXT_REDIRECT /login?callbackUrl=%2Fchat");
  });
});
