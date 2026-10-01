// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db/index";
import { media, memberSpotlights, memberSpotlightSubmissions, users } from "@/db/schema";
import { SpotlightBucket } from "../helpers/spotlight-bucket";
import { openTempDb } from "../helpers/temp-db";

const state = vi.hoisted(() => ({ db: null as unknown as Db, bucket: null as unknown as SpotlightBucket, session: null as unknown }));
const router = vi.hoisted(() => ({ refresh: vi.fn(), replace: vi.fn() }));
vi.mock("@/lib/runtime", () => ({ getDb: () => state.db }));
vi.mock("@/lib/r2", async (original) => ({ ...await original<typeof import("@/lib/r2")>(), getMediaBucket: () => state.bucket }));
vi.mock("next/navigation", () => ({ useRouter: () => router, redirect: (url: string) => { throw new Error(`redirect:${url}`); } }));
vi.mock("@/lib/auth", async (original) => {
  const actual = await original<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireUser: () => actual.requireUser({ db: state.db, getSession: async () => state.session }),
    requireRole: (role: import("@/lib/auth").Role) => actual.requireRole(role, { db: state.db, getSession: async () => state.session }),
    withRole: <C,>(role: import("@/lib/auth").Role, handler: (request: Request, context: C, user: import("@/lib/auth").AuthUser) => Promise<Response>) =>
      actual.withRole(role, handler, () => ({ db: state.db, getSession: async () => state.session })),
  };
});

import SpotlightsPage from "@/app/admin/spotlights/page";
import { rejectSpotlightSubmissionAction } from "@/app/admin/_actions/spotlight-submissions";
import { GET as getSubmissionImage } from "@/app/api/spotlight-submissions/[id]/images/[kind]/route";

let db: Db;
let close: () => void;
const id = "submission-integration";
const bytes = new Uint8Array([255, 216, 255, 224, 1, 2, 3]);
const payload = { companyName: "紹介会社", personName: "山田 太郎", personNameKana: "やまだ たろう", role: "デザイナー", quote: "毎日が実験です", bio: "映像とWebを作っています", tags: ["映像"] };

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  ({ db, close } = await openTempDb());
  state.db = db;
  state.bucket = new SpotlightBucket();
  const [user] = await db.insert(users).values({ email: "staff@example.com", role: "staff", name: "スタッフ" }).returning();
  state.session = { userId: user.id, sessionVersion: user.sessionVersion };
  await db.insert(memberSpotlightSubmissions).values({
    id, requestKey: crypto.randomUUID(), requestFingerprint: "a".repeat(64), status: "pending", payload,
    consentedAt: 1_790_000_000, consentVersion: 1, submittedAt: 1_790_000_000,
    photoFile: { r2Key: `member-submissions/${id}/photo`, mimeType: "image/jpeg", size: bytes.length, sha256: "b".repeat(64) },
  });
  state.bucket.objects.set(`member-submissions/${id}/photo`, bytes);
});
afterEach(() => { cleanup(); env.RESEND_API_KEY = undefined; vi.unstubAllGlobals(); close(); });

/** /admin/spotlights（?tab なし）を開いたときのページ */
const renderPage = () => SpotlightsPage({ searchParams: Promise.resolve({}) });

function openPending() {
  fireEvent.click(screen.getByRole("button", { name: "確認待ち（1件）" }));
  fireEvent.click(screen.getByRole("button", { name: "内容を確認" }));
}

describe("管理ページと実Action・サービス・プレビューの接続", () => {
  it.each(["approve", "reject"] as const)("%s で実Actionの通知結果を示し、メールアドレスを掲載内容に含めない", async (review) => {
    env.RESEND_API_KEY = "test-resend-key";
    const send = vi.fn().mockResolvedValue(Response.json({ id: "email-integration" }));
    vi.stubGlobal("fetch", send);
    await db.update(memberSpotlightSubmissions).set({ contactEmail: "member@example.com", consentVersion: 2 }).where(eq(memberSpotlightSubmissions.id, id));
    render(await renderPage());
    openPending();
    expect(screen.getByText("member@example.com")).toBeTruthy();
    expect(screen.getByTestId("spotlight").textContent).not.toContain("member@example.com");
    fireEvent.click(screen.getByRole("button", { name: review === "approve" ? "掲載する" : "却下" }));
    if (review === "reject") fireEvent.click(screen.getByRole("button", { name: "却下する" }));
    await waitFor(() => expect(router.refresh).toHaveBeenCalledOnce());
    expect(screen.getByRole("status").textContent).toContain("結果をメールでお知らせしました。");
    expect(send).toHaveBeenCalledOnce();
    const [submission] = await db.select().from(memberSpotlightSubmissions).where(eq(memberSpotlightSubmissions.id, id));
    expect(submission).toMatchObject({ contactEmail: null, notificationStatus: "sent", status: review === "approve" ? "approved" : "rejected" });
    expect(JSON.stringify(submission.payload)).not.toContain("member@example.com");
    const published = await db.select().from(memberSpotlights);
    expect(published).toHaveLength(review === "approve" ? 1 : 0);
    expect(JSON.stringify(published)).not.toContain("member@example.com");
  });

  it("実際のStaff画像と掲載カードを確認して承認するとDBに掲載され、再取得で件数と掲載一覧が更新される", async () => {
    const view = render(await renderPage());
    openPending();
    expect(screen.getByText("未登録（通知なし）")).toBeTruthy();
    const preview = screen.getByTestId("spotlight");
    expect(within(preview).getByText(payload.companyName)).toBeTruthy();
    expect(within(preview).getByText(payload.personName)).toBeTruthy();
    const imageUrl = screen.getByRole("img", { name: "本人写真" }).getAttribute("src")!;
    expect(preview.querySelector("img")?.getAttribute("src")).toBe(imageUrl);
    const response = await getSubmissionImage(new Request(`https://signage.example.com${imageUrl}`), { params: Promise.resolve({ id, kind: "photo" }) });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);

    fireEvent.click(screen.getByRole("button", { name: "掲載する" }));
    await waitFor(() => expect(router.refresh).toHaveBeenCalledOnce());
    expect(screen.queryByRole("region", { name: "申請内容の確認" })).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("メールアドレスが未登録のため、結果のメールは送りません。");
    expect(await db.select().from(memberSpotlights)).toMatchObject([{ personName: payload.personName, enabled: true }]);
    expect(await db.select().from(media)).toMatchObject([{ r2Key: `member-submissions/${id}/photo` }]);
    view.rerender(await renderPage());
    expect(screen.getByRole("button", { name: "確認待ち（0件）" })).toBeTruthy();
    expect(screen.getByText("確認待ちの申請はありません。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "掲載メンバー" }));
    expect(within(screen.getByRole("region", { name: "メンバー紹介一覧" })).getByText("山田 太郎さん")).toBeTruthy();
  });

  it("別スタッフの却下後に古い詳細から掲載しても、実Actionの競合で詳細を閉じて最新件数へ戻る", async () => {
    const view = render(await renderPage());
    openPending();
    expect(await rejectSpotlightSubmissionAction(id, 0)).toEqual({ data: { notificationStatus: "skipped" } });
    fireEvent.click(screen.getByRole("button", { name: "掲載する" }));
    await waitFor(() => expect(router.refresh).toHaveBeenCalledOnce());
    expect(screen.getByRole("alert").textContent).toContain("他のスタッフが処理しました");
    expect(screen.queryByRole("region", { name: "申請内容の確認" })).toBeNull();
    view.rerender(await renderPage());
    expect(screen.getByRole("button", { name: "確認待ち（0件）" })).toBeTruthy();
    expect(await db.select().from(memberSpotlights)).toHaveLength(0);
    const [submission] = await db.select().from(memberSpotlightSubmissions).where(eq(memberSpotlightSubmissions.id, id));
    expect(submission.status).toBe("rejected");
  });
});
