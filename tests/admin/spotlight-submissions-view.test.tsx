// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpotlightSubmissionDetail } from "@/lib/spotlight-submissions";

const actions = vi.hoisted(() => ({
  approveSpotlightSubmissionAction: vi.fn(),
  rejectSpotlightSubmissionAction: vi.fn(),
}));
const router = vi.hoisted(() => ({ refresh: vi.fn() }));
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
  submittedAt: 1_790_000_000,
  consentedAt: 1_790_000_000,
  consentVersion: 1,
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
  actions.approveSpotlightSubmissionAction.mockResolvedValue({ data: { spotlightId: "spt-approved" } });
  actions.rejectSpotlightSubmissionAction.mockResolvedValue({ data: null });
});
afterEach(cleanup);

describe("確認待ちの審査", () => {
  it("古い順に並べ、全入力とStaff専用画像を確認して共通プレビューへ渡せる", () => {
    render(<SpotlightSubmissionsView submissions={[another, submission]} />);
    const rows = within(screen.getByRole("region", { name: "確認待ち一覧" })).getAllByRole("listitem");
    expect(rows.map((row) => within(row).getByText(/さん$/).textContent)).toEqual(["山田 太郎さん", "佐藤 次郎さん"]);
    openFirst();
    const detail = within(screen.getByRole("region", { name: "申請内容の確認" }));
    for (const value of Object.values(submission.payload).filter((v) => typeof v === "string")) {
      expect(detail.getByText(value)).toBeTruthy();
    }
    expect(detail.getByText("映像・Web")).toBeTruthy();
    expect(detail.getByText("掲載先への同意日時")).toBeTruthy();
    expect(detail.getByRole("img", { name: "本人写真" }).getAttribute("src")).toBe(submission.photoUrl);
    expect(detail.getByRole("img", { name: "会社ロゴ" }).getAttribute("src")).toBe(submission.logoUrl);
    expect(preview).toHaveBeenLastCalledWith({ payload: submission.payload, photoUrl: submission.photoUrl, logoUrl: submission.logoUrl });
  });

  it("掲載するを一度押すとid/revisionだけで承認し、処理中は重複操作を止め、成功後に詳細を閉じて再取得する", async () => {
    let resolve!: (value: { data: { spotlightId: string } }) => void;
    actions.approveSpotlightSubmissionAction.mockReturnValue(new Promise((done) => { resolve = done; }));
    render(<SpotlightSubmissionsView submissions={[submission]} />);
    openFirst();
    fireEvent.click(screen.getByRole("button", { name: "掲載する" }));
    expect(actions.approveSpotlightSubmissionAction).toHaveBeenCalledExactlyOnceWith(submission.id, submission.revision);
    await waitFor(() => expect((screen.getByRole("button", { name: "処理中…" }) as HTMLButtonElement).disabled).toBe(true));
    expect((screen.getByRole("button", { name: "却下" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => resolve({ data: { spotlightId: "spt-approved" } }));
    expect(screen.queryByRole("region", { name: "申請内容の確認" })).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("掲載しました");
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
    expect(screen.getByRole("status").textContent).toBe("申請を却下しました。");
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
