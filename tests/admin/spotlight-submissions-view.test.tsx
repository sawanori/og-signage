// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpotlightNotificationStatus, SpotlightSubmissionDetail } from "@/lib/spotlight-submissions";

const actions = vi.hoisted(() => ({
  approveSpotlightSubmissionAction: vi.fn(),
  rejectSpotlightSubmissionAction: vi.fn(),
}));
const router = vi.hoisted(() => ({ refresh: vi.fn(), replace: vi.fn() }));
const preview = vi.hoisted(() => vi.fn());
vi.mock("@/app/admin/_actions/spotlight-submissions", () => actions);
vi.mock("@/app/admin/_actions/spotlights", () => ({
  createSpotlightAction: vi.fn(), updateSpotlightAction: vi.fn(), deleteSpotlightAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/components/members/spotlight-preview", () => ({
  SpotlightPreview: (props: unknown) => { preview(props); return <div>紹介カードのプレビュー</div>; },
}));

import { SpotlightSubmissionsView } from "@/components/admin/spotlight-submissions-view";
import { SpotlightsView } from "@/components/admin/spotlights-view";

const submission: SpotlightSubmissionDetail = {
  id: "submission-a",
  revision: 2,
  companyName: "NonTurn",
  personName: "山田 太郎",
  contactEmail: "member@example.com",
  submittedAt: 1_790_000_000,
  consentedAt: 1_790_000_000,
  consentVersion: 2,
  photoUrl: "/api/spotlight-submissions/submission-a/images/photo",
  logoUrl: "/api/spotlight-submissions/submission-a/images/logo",
  payload: {
    companyName: "NonTurn",
    personName: "山田 太郎",
    personNameKana: "やまだ たろう",
    role: "デザイナー",
    quote: "毎日が実験です",
    bio: "映像とWebを作っています",
    tags: ["映像", "Web"],
    websiteUrl: "https://example.com/nonturn",
    websiteUrl2: "https://example.com/nonturn/profile",
  },
};
const another: SpotlightSubmissionDetail = {
  ...submission,
  id: "submission-b",
  personName: "佐藤 次郎",
  submittedAt: submission.submittedAt + 100,
  photoUrl: null,
  logoUrl: null,
  payload: { ...submission.payload, personName: "佐藤 次郎" },
};

function openFirst() {
  fireEvent.click(screen.getAllByRole("button", { name: "内容を確認" })[0]);
}

beforeEach(() => {
  vi.clearAllMocks();
  actions.approveSpotlightSubmissionAction.mockResolvedValue({ data: { spotlightId: "spt-approved", notificationStatus: "sent" } });
  actions.rejectSpotlightSubmissionAction.mockResolvedValue({ data: { notificationStatus: "sent" } });
});
afterEach(cleanup);

describe("確認待ちの審査", () => {
  it("古い順に並べ、全入力とStaff専用画像を確認して共通プレビューへ渡せる", () => {
    render(<SpotlightSubmissionsView submissions={[another, submission]} />);
    const rows = within(screen.getByRole("region", { name: "確認待ち一覧" })).getAllByRole("listitem");
    expect(rows.map((row) => within(row).getByText(/さん$/).textContent)).toEqual(["山田 太郎さん", "佐藤 次郎さん"]);
    expect(screen.queryByText("member@example.com")).toBeNull();
    openFirst();
    const detail = within(screen.getByRole("region", { name: "申請内容の確認" }));
    for (const value of Object.values(submission.payload).filter((v) => typeof v === "string")) {
      expect(detail.getByText(value)).toBeTruthy();
    }
    expect(detail.getByText("映像・Web")).toBeTruthy();
    expect(detail.getByText("掲載先への同意日時")).toBeTruthy();
    expect(detail.getByText("メールアドレス（結果の通知先。サイネージには表示しません）")).toBeTruthy();
    expect(detail.getByText("member@example.com")).toBeTruthy();
    expect(detail.getByRole("img", { name: "本人写真" }).getAttribute("src")).toBe(submission.photoUrl);
    // 会社のロゴはサイネージに出さないので確認にも出さない。ホームページは QR で出すので確認に出す（2026-10-01 ユーザー指示）
    expect(detail.queryByRole("img", { name: "会社ロゴ" })).toBeNull();
    expect(detail.getByText("ホームページのURL 1（サイネージにQRコードで出します）")).toBeTruthy();
    expect(detail.getByText("ホームページのURL 2")).toBeTruthy();
    expect(preview).toHaveBeenLastCalledWith({ payload: {
      companyName: submission.payload.companyName,
      personName: submission.payload.personName,
      role: submission.payload.role,
      quote: submission.payload.quote,
      bio: submission.payload.bio,
      tags: submission.payload.tags,
      websiteUrl: submission.payload.websiteUrl,
    }, photoUrl: submission.photoUrl });
    expect(JSON.stringify(preview.mock.calls)).not.toContain(submission.payload.websiteUrl2!);
    expect(JSON.stringify(preview.mock.calls)).not.toContain("member@example.com");
  });

  it("URL 2だけの申請も確認でき、掲載イメージにはURLを渡さない", () => {
    render(<SpotlightSubmissionsView submissions={[{ ...submission, payload: { ...submission.payload, websiteUrl: null } }]} />);
    openFirst();
    expect(screen.getByText(submission.payload.websiteUrl2!)).toBeTruthy();
    expect(preview.mock.calls.at(-1)?.[0].payload.websiteUrl).toBeNull();
    expect(preview.mock.calls.at(-1)?.[0].payload).not.toHaveProperty("websiteUrl2");
  });

  it("メールアドレスのない既存申請も詳細を開け、通知がないことを示す", () => {
    render(<SpotlightSubmissionsView submissions={[{ ...submission, contactEmail: null, consentVersion: 1 }]} />);
    openFirst();
    expect(screen.getByText("未登録（通知なし）")).toBeTruthy();
    expect(screen.getByRole("button", { name: "掲載する" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "却下" })).toBeTruthy();
  });

  it("掲載するを一度押すとid/revisionだけで承認し、処理中は重複操作を止め、成功後に詳細を閉じて再取得する", async () => {
    let resolve!: (value: { data: { spotlightId: string; notificationStatus: "sent" } }) => void;
    actions.approveSpotlightSubmissionAction.mockReturnValue(new Promise((done) => { resolve = done; }));
    render(<SpotlightSubmissionsView submissions={[submission]} />);
    openFirst();
    fireEvent.click(screen.getByRole("button", { name: "掲載する" }));
    expect(actions.approveSpotlightSubmissionAction).toHaveBeenCalledExactlyOnceWith(submission.id, submission.revision);
    await waitFor(() => expect((screen.getByRole("button", { name: "処理中…" }) as HTMLButtonElement).disabled).toBe(true));
    expect((screen.getByRole("button", { name: "却下" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => resolve({ data: { spotlightId: "spt-approved", notificationStatus: "sent" } }));
    expect(screen.queryByRole("region", { name: "申請内容の確認" })).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("掲載しました");
    expect(screen.getByRole("status").textContent).toContain("結果をメールでお知らせしました。");
    expect(router.refresh).toHaveBeenCalledOnce();
    expect((screen.getByRole("button", { name: "内容を確認" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("却下は確認ダイアログで取消でき、確定した場合だけ却下して一覧を更新する", async () => {
    render(<SpotlightSubmissionsView submissions={[submission]} />);
    openFirst();
    fireEvent.click(screen.getByRole("button", { name: "却下" }));
    expect(screen.getByRole("alertdialog")).toBeTruthy();
    expect(actions.rejectSpotlightSubmissionAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "やめる" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "却下" }));
    fireEvent.click(screen.getByRole("button", { name: "却下する" }));
    await waitFor(() => expect(router.refresh).toHaveBeenCalledOnce());
    expect(actions.rejectSpotlightSubmissionAction).toHaveBeenCalledExactlyOnceWith(submission.id, submission.revision);
    expect(screen.queryByRole("region", { name: "申請内容の確認" })).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("申請を却下しました。結果をメールでお知らせしました。");
  });

  it.each(["approve", "reject"] as const)("%s 後の通知の再送・終了・未登録を結果として表示する", async (review) => {
    const statuses: [SpotlightNotificationStatus, string][] = [
      ["pending", "結果のメールを送れなかったため、自動で再送します。"],
      ["failed", "結果のメールを送れず、再送を終了しました。"],
      ["skipped", "メールアドレスが未登録のため、結果のメールは送りません。"],
    ];
    for (const [notificationStatus, expected] of statuses) {
      const action = review === "approve" ? actions.approveSpotlightSubmissionAction : actions.rejectSpotlightSubmissionAction;
      action.mockResolvedValueOnce({ data: { spotlightId: "spt-approved", notificationStatus } });
      const view = render(<SpotlightSubmissionsView submissions={[submission]} />);
      openFirst();
      fireEvent.click(screen.getByRole("button", { name: review === "approve" ? "掲載する" : "却下" }));
      if (review === "reject") fireEvent.click(screen.getByRole("button", { name: "却下する" }));
      expect((await screen.findByRole("status")).textContent).toContain(expected);
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByRole("region", { name: "申請内容の確認" })).toBeNull();
      view.unmount();
    }
  });

  it("競合時は古い詳細を閉じ、同じrevisionの再操作を止め、最新一覧を読み直す", async () => {
    actions.approveSpotlightSubmissionAction.mockResolvedValue({ error: { code: "conflict", message: "更新済み" } });
    const view = render(<SpotlightSubmissionsView submissions={[submission]} />);
    openFirst();
    fireEvent.click(screen.getByRole("button", { name: "掲載する" }));
    await waitFor(() => expect(router.refresh).toHaveBeenCalledOnce());
    expect(screen.getByRole("alert").textContent).toContain("他のスタッフが処理しました");
    expect(screen.queryByRole("region", { name: "申請内容の確認" })).toBeNull();
    expect((screen.getByRole("button", { name: "内容を確認" }) as HTMLButtonElement).disabled).toBe(true);
    view.rerender(<SpotlightSubmissionsView submissions={[]} />);
    expect(screen.getByText("確認待ちの申請はありません。")).toBeTruthy();
  });

  it("認証エラーと通信失敗を成功にせず、詳細を維持して理由を知らせる", async () => {
    actions.approveSpotlightSubmissionAction.mockResolvedValueOnce({ error: { code: "unauthorized", message: "ログインしてください" } });
    render(<SpotlightSubmissionsView submissions={[submission]} />);
    openFirst();
    fireEvent.click(screen.getByRole("button", { name: "掲載する" }));
    expect((await screen.findByRole("alert")).textContent).toBe("ログインしてください");
    expect(screen.getByRole("region", { name: "申請内容の確認" })).toBeTruthy();
    expect(router.refresh).not.toHaveBeenCalled();
    actions.approveSpotlightSubmissionAction.mockRejectedValueOnce(new Error("offline"));
    fireEvent.click(screen.getByRole("button", { name: "掲載する" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("処理結果を確認できませんでした"));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("既存一覧と確認待ちを切り替え、承認後の再取得で件数と空表示を更新する", async () => {
    const view = render(<SpotlightsView spotlights={[]} submissions={[submission]} />);
    expect(screen.getByRole("region", { name: "メンバー紹介一覧" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "確認待ち（1件）" }));
    expect(screen.queryByRole("region", { name: "メンバー紹介一覧" })).toBeNull();
    openFirst();
    fireEvent.click(screen.getByRole("button", { name: "掲載する" }));
    await waitFor(() => expect(router.refresh).toHaveBeenCalledOnce());
    view.rerender(<SpotlightsView spotlights={[]} submissions={[]} />);
    expect(screen.getByRole("button", { name: "確認待ち（0件）" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("確認待ちの申請はありません。")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "掲載メンバー" }));
    expect(screen.getByRole("region", { name: "メンバー紹介一覧" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "メンバーを追加" })).toBeTruthy();
  });
});
