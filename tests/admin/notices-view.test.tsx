// @vitest-environment jsdom
/**
 * お知らせの編集（components/admin/notices-view.tsx）。QR の飛び先（任意。2026-09-25 ユーザー指示）を入れて保存できる。
 * Server Actions と画面遷移は差し替える。
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NoticeRow } from "@/lib/services/notices";

const actions = vi.hoisted(() => ({
  createNoticeAction: vi.fn(),
  updateNoticeAction: vi.fn(),
  deleteNoticeAction: vi.fn(),
}));
vi.mock("@/app/admin/_actions/content", () => actions);
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/lib/client/upload", () => ({ uploadMedia: vi.fn(), UploadError: class UploadError extends Error {} }));

import { NoticesView } from "@/components/admin/notices-view";

const notice: NoticeRow = {
  id: "ntc_power",
  title: "停電あるよ",
  body: "年一の停電です。",
  imageMediaId: null,
  qrUrl: "https://example.com/power",
  enabled: true,
  displayMode: "always",
  displayStartTime: null,
  displayEndTime: null,
  revision: 3,
  createdAt: 1_790_000_000,
  updatedAt: 1_790_000_000,
};

beforeEach(() => {
  vi.clearAllMocks();
  actions.createNoticeAction.mockResolvedValue({ data: { ...notice, id: "ntc_new" } });
  actions.updateNoticeAction.mockResolvedValue({ data: notice });
});
afterEach(cleanup);

describe("NoticesView の QR の飛び先", () => {
  it("新しいお知らせで QR の URL を入れて保存すると、前後の空白を除いて送る", async () => {
    render(<NoticesView notices={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "新しいお知らせ" }));
    fireEvent.change(screen.getByLabelText("見出し"), { target: { value: "停電あるよ" } });
    fireEvent.change(screen.getByLabelText("QR コード（任意・飛び先の URL）"), { target: { value: " https://example.com/power " } });
    fireEvent.click(screen.getByRole("button", { name: "保存する" }));
    await waitFor(() => expect(actions.createNoticeAction).toHaveBeenCalled());
    expect(actions.createNoticeAction.mock.calls[0][0]).toMatchObject({ title: "停電あるよ", qrUrl: "https://example.com/power" });
  });

  it("編集では今の URL が入っていて、空にして保存すると null を送る（QR を出さない）", async () => {
    render(<NoticesView notices={[notice]} />);
    fireEvent.click(screen.getByRole("button", { name: /編集/ }));
    const input = screen.getByLabelText("QR コード（任意・飛び先の URL）") as HTMLInputElement;
    expect(input.value).toBe("https://example.com/power");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "保存する" }));
    await waitFor(() => expect(actions.updateNoticeAction).toHaveBeenCalled());
    expect(actions.updateNoticeAction.mock.calls[0]).toEqual(["ntc_power", expect.objectContaining({ qrUrl: null, revision: 3 })]);
  });
});
