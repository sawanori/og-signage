// @vitest-environment jsdom
/**
 * イベントのフォーム（task_016）。必須の検査、終了 < 開始、保存の中身、競合時に入力を保つこと。
 * Server Actions と画面遷移は差し替える。
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tokyoDateTime } from "@/lib/dates";

const actions = vi.hoisted(() => ({
  createEventAction: vi.fn(),
  updateEventAction: vi.fn(),
  getEventAction: vi.fn(),
  deleteEventAction: vi.fn(),
}));
const push = vi.hoisted(() => vi.fn());

vi.mock("@/app/admin/_actions/events", () => actions);
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/lib/client/upload", () => ({
  uploadMedia: vi.fn(),
  UploadError: class UploadError extends Error {},
}));

import { CONFLICT_MESSAGE, EventForm } from "@/components/admin/event-form";
import type { EventFormSource } from "@/components/admin/event-form-model";

const NOW = tokyoDateTime(2025, 9, 24, 17, 42);
const categories = [{ id: "cat_social", name: "交流", color: "#EF6B73" }];

const pizza: EventFormSource = {
  title: "Pizza Night",
  description: null,
  location: "2F ラウンジ",
  startAt: tokyoDateTime(2025, 9, 24, 19, 30),
  endAt: tokyoDateTime(2025, 9, 24, 21, 30),
  categoryId: "cat_social",
  emoji: "🍕",
  hostName: null,
  catchCopy: null,
  participation: "limited",
  capacity: 20,
  participantCount: 12,
  qrUrl: null,
  imageMediaId: null,
  status: "published",
};

const input = (label: string) => screen.getByLabelText(label, { exact: false }) as HTMLInputElement;
const type = (label: string, value: string) => fireEvent.change(input(label), { target: { value } });
const save = () => fireEvent.click(screen.getByRole("button", { name: "保存する" }));

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(cleanup);

describe("EventForm（追加）", () => {
  it("イベント名と開始日時が空なら保存せずエラーを出す", async () => {
    render(<EventForm mode="create" now={NOW} categories={categories} />);
    type("開始日時", "");
    save();
    expect(await screen.findByText("イベント名を入力してください")).toBeTruthy();
    expect(screen.getByText("開始日時を入力してください")).toBeTruthy();
    expect(actions.createEventAction).not.toHaveBeenCalled();
  });

  it("終了が開始より前ならエラーを出す", async () => {
    render(<EventForm mode="create" now={NOW} categories={categories} />);
    type("イベント名", "Pizza Night");
    type("開始の時刻", "19:30");
    type("終了日時", "18:00");
    save();
    expect(await screen.findByText("終了は開始より後にしてください")).toBeTruthy();
    expect(actions.createEventAction).not.toHaveBeenCalled();
  });

  it("イベント名と開始日時だけで保存でき、一覧へ戻る", async () => {
    actions.createEventAction.mockResolvedValue({ ok: true, data: { id: "e1" } });
    render(<EventForm mode="create" now={NOW} categories={categories} />);
    type("イベント名", "Pizza Night");
    type("開始の時刻", "19:30");
    save();
    await waitFor(() => expect(actions.createEventAction).toHaveBeenCalledTimes(1));
    expect(actions.createEventAction.mock.calls[0][0]).toEqual({
      title: "Pizza Night",
      description: null,
      location: null,
      startAt: tokyoDateTime(2025, 9, 24, 19, 30),
      endAt: null,
      categoryId: null,
      emoji: null,
      hostName: null,
      catchCopy: null,
      participation: "free",
      capacity: null,
      participantCount: null,
      qrUrl: null,
      imageMediaId: null,
      status: "published",
    });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/admin/events?saved=created"));
  });

  it("終わっていないイベントが上限に達していたら、先に知らせて保存できないようにする（2026-09-25 ユーザー指示）", () => {
    render(<EventForm mode="create" now={NOW} categories={categories} limit={{ count: 6, max: 5 }} />);
    const notice = screen.getByTestId("event-limit");
    expect(notice.textContent).toContain("終わっていないイベントが 6 件あります");
    expect(notice.textContent).toContain("5 件まで");
    expect(screen.getByRole("link", { name: "イベント一覧へ" }).getAttribute("href")).toBe("/admin/events");
    expect((screen.getByRole("button", { name: "保存する" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("上限に達していなければ、知らせは出さない", () => {
    render(<EventForm mode="create" now={NOW} categories={categories} limit={null} />);
    expect(screen.queryByTestId("event-limit")).toBeNull();
    expect((screen.getByRole("button", { name: "保存する" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("終了なしの説明を出す", () => {
    render(<EventForm mode="create" now={NOW} categories={categories} />);
    expect(screen.getByText(/未入力の場合はその日の終わりまで表示されます/)).toBeTruthy();
  });

  it("保存に失敗したら入力を保ったまま理由を出す", async () => {
    actions.createEventAction.mockResolvedValue({
      ok: false,
      error: { code: "invalid_category", message: "選んだカテゴリが見つかりません。選び直してください" },
    });
    render(<EventForm mode="create" now={NOW} categories={categories} />);
    type("イベント名", "Pizza Night");
    type("開始の時刻", "19:30");
    save();
    expect(await screen.findByText("選んだカテゴリが見つかりません。選び直してください")).toBeTruthy();
    expect(input("イベント名").value).toBe("Pizza Night");
    expect(push).not.toHaveBeenCalled();
  });
});

describe("EventForm（編集）", () => {
  it("他の人が先に更新していたら入力を保ったまま知らせ、次の保存は最新の版で送る", async () => {
    actions.updateEventAction
      .mockResolvedValueOnce({ ok: false, error: { code: "conflict", message: "他の人が先に更新しました" } })
      .mockResolvedValueOnce({ ok: true, data: { id: "e1" } });
    actions.getEventAction.mockResolvedValue({ ok: true, data: { ...pizza, id: "e1", revision: 4 } });

    render(<EventForm mode="edit" eventId="e1" event={pizza} revision={3} categories={categories} />);
    type("イベント名", "Pizza Night 2");
    save();

    expect(await screen.findByText(CONFLICT_MESSAGE)).toBeTruthy();
    expect(actions.updateEventAction.mock.calls[0][1]).toMatchObject({ title: "Pizza Night 2", revision: 3 });
    expect(input("イベント名").value).toBe("Pizza Night 2");
    expect(push).not.toHaveBeenCalled();

    save();
    await waitFor(() => expect(actions.updateEventAction).toHaveBeenCalledTimes(2));
    expect(actions.updateEventAction.mock.calls[1][1]).toMatchObject({ title: "Pizza Night 2", revision: 4 });
    await waitFor(() => expect(push).toHaveBeenCalledWith("/admin/events?saved=updated"));
  });

  it("削除は確認してから行う", async () => {
    actions.deleteEventAction.mockResolvedValue({ ok: true, data: null });
    render(<EventForm mode="edit" eventId="e1" event={pizza} revision={3} categories={categories} />);
    fireEvent.click(screen.getByRole("button", { name: /このイベントを削除する/ }));
    expect(screen.getByRole("alertdialog").textContent).toContain("「Pizza Night」を削除します");
    expect(actions.deleteEventAction).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "削除する" }));
    await waitFor(() => expect(actions.deleteEventAction).toHaveBeenCalledWith("e1"));
    await waitFor(() => expect(push).toHaveBeenCalledWith("/admin/events?saved=deleted"));
  });
});
