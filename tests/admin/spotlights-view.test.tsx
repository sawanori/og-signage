// @vitest-environment jsdom
/**
 * メンバー紹介の画面（components/admin/spotlights-view.tsx。2026-09-26 ユーザー指示）。
 * 一覧の表示と、追加・編集・削除で Server Action に渡す内容。revision 競合はお知らせと同じく知らせて読み込み直す。
 * Server Actions・画面遷移・アップロードは差し替える。
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SpotlightRow } from "@/lib/services/spotlights";

const actions = vi.hoisted(() => ({
  createSpotlightAction: vi.fn(),
  updateSpotlightAction: vi.fn(),
  deleteSpotlightAction: vi.fn(),
}));
const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }));
vi.mock("@/app/admin/_actions/spotlights", () => actions);
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/lib/client/upload", () => ({ uploadMedia: vi.fn(), UploadError: class UploadError extends Error {} }));

import { SpotlightsView } from "@/components/admin/spotlights-view";
import { uploadMedia } from "@/lib/client/upload";

const SAVED = "保存しました。サイネージには 30 秒以内に反映されます。";
const PERSON_LABEL = "お名前（サイネージでは「さん」を付けて出します）";
const QUOTE_LABEL = "ひとこと（任意。サイネージでは「」で囲んで出します）";
const PHOTO_LABEL = "写真（任意。縦長の写真がきれいに出ます）";

const yamada: SpotlightRow = {
  id: "spt_yamada",
  companyName: "株式会社サンプル",
  personName: "山田 太郎",
  role: "デザイナー",
  quote: "毎日が実験です",
  bio: "映像と Web を作っています",
  tags: ["映像", "Web"],
  photoMediaId: "img_yamada",
  logoMediaId: null,
  enabled: true,
  revision: 2,
  createdAt: 1_790_000_000,
  updatedAt: 1_790_000_000,
};

const sato: SpotlightRow = {
  ...yamada,
  id: "spt_sato",
  companyName: "佐藤商店",
  personName: "佐藤 次郎",
  role: null,
  quote: null,
  bio: null,
  tags: [],
  photoMediaId: null,
  enabled: false,
  revision: 0,
};

const saveButton = () => screen.getByRole("button", { name: "保存する" }) as HTMLButtonElement;

/** アップロードを途中で止めておく。返した関数を呼ぶと終わる */
function holdUpload(): (media: { id: string; type: "image" }) => void {
  let finish!: (media: { id: string; type: "image" }) => void;
  vi.mocked(uploadMedia).mockImplementation(
    () => new Promise((resolve) => (finish = resolve as typeof finish)) as ReturnType<typeof uploadMedia>,
  );
  return (media) => finish(media);
}

const choosePhoto = () =>
  fireEvent.change(screen.getByLabelText(PHOTO_LABEL), {
    target: { files: [new File(["x"], "photo.jpg", { type: "image/jpeg" })] },
  });

beforeEach(() => {
  vi.clearAllMocks();
  actions.createSpotlightAction.mockResolvedValue({ data: { ...yamada, id: "spt_new" } });
  actions.updateSpotlightAction.mockResolvedValue({ data: yamada });
  actions.deleteSpotlightAction.mockResolvedValue({ data: null });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("SpotlightsView の一覧", () => {
  it("写真・お名前（さん付き）・会社名と肩書き・サイネージに出すかを登録順に出す", () => {
    render(<SpotlightsView spotlights={[yamada, sato]} />);
    expect(screen.getByText("サイネージの右上の MEMBER SPOTLIGHT に、登録順に 1 人ずつ切り替えて出します。")).toBeTruthy();

    const [first, second] = within(screen.getByRole("region", { name: "メンバー紹介一覧" })).getAllByRole("listitem");
    expect(within(first).getByText("山田 太郎さん")).toBeTruthy();
    expect(within(first).getByText("株式会社サンプル / デザイナー")).toBeTruthy();
    expect(within(first).getByText("表示する")).toBeTruthy();
    expect(first.querySelector("img")?.getAttribute("src")).toBe("/api/media/img_yamada/thumbnail");

    expect(within(second).getByText("佐藤 次郎さん")).toBeTruthy();
    expect(within(second).getByText("佐藤商店")).toBeTruthy();
    expect(within(second).getByText("表示しない")).toBeTruthy();
    expect(second.querySelector("img")).toBeNull();
  });

  it("まだ誰もいなければその旨を出す", () => {
    render(<SpotlightsView spotlights={[]} />);
    expect(screen.getByText("メンバー紹介はまだありません。")).toBeTruthy();
  });
});

describe("SpotlightsView の追加・編集・削除", () => {
  it("新しく追加すると入力した内容で作成する。任意の空欄は null、空のタグ欄は除く", async () => {
    render(<SpotlightsView spotlights={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "メンバーを追加" }));
    // 会社名とお名前が入るまでは保存できない
    expect(saveButton().disabled).toBe(true);

    fireEvent.change(screen.getByLabelText("会社名"), { target: { value: "株式会社サンプル" } });
    fireEvent.change(screen.getByLabelText(PERSON_LABEL), { target: { value: "山田 太郎" } });
    fireEvent.change(screen.getByLabelText(QUOTE_LABEL), { target: { value: "毎日が実験です" } });
    fireEvent.change(screen.getByLabelText("タグ 1"), { target: { value: " 映像 " } });
    fireEvent.change(screen.getByLabelText("タグ 3"), { target: { value: "Web" } });
    fireEvent.click(screen.getByRole("switch", { name: "サイネージに出す" }));
    fireEvent.click(saveButton());

    await waitFor(() => expect(actions.createSpotlightAction).toHaveBeenCalledTimes(1));
    expect(actions.createSpotlightAction.mock.calls[0][0]).toEqual({
      companyName: "株式会社サンプル",
      personName: "山田 太郎",
      role: null,
      quote: "毎日が実験です",
      bio: null,
      tags: ["映像", "Web"],
      photoMediaId: null,
      logoMediaId: null,
      enabled: false,
    });
    expect(await screen.findByText(SAVED)).toBeTruthy();
    expect(router.refresh).toHaveBeenCalled();
  });

  it("ひとことの文字数を出し、上限（30 文字）を超えると送らずに知らせる", async () => {
    render(<SpotlightsView spotlights={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "メンバーを追加" }));
    fireEvent.change(screen.getByLabelText("会社名"), { target: { value: "株式会社サンプル" } });
    fireEvent.change(screen.getByLabelText(PERSON_LABEL), { target: { value: "山田 太郎" } });
    fireEvent.change(screen.getByLabelText(QUOTE_LABEL), { target: { value: "あ".repeat(31) } });
    expect(screen.getByText("31 / 30")).toBeTruthy();
    expect(screen.getByText("0 / 60")).toBeTruthy();

    fireEvent.click(saveButton());
    expect((await screen.findByRole("alert")).textContent).toBe("ひとことは30文字以内で入力してください");
    expect(actions.createSpotlightAction).not.toHaveBeenCalled();
  });

  it("写真のアップロードを待つあいだは保存できず、そのあいだに書いた内容も写真と一緒に保存する", async () => {
    const finishUpload = holdUpload();
    render(<SpotlightsView spotlights={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "メンバーを追加" }));

    choosePhoto();
    fireEvent.change(screen.getByLabelText("会社名"), { target: { value: "株式会社サンプル" } });
    fireEvent.change(screen.getByLabelText(PERSON_LABEL), { target: { value: "山田 太郎" } });
    expect(saveButton().disabled).toBe(true);

    await act(async () => finishUpload({ id: "img_new", type: "image" }));
    await waitFor(() => expect(saveButton().disabled).toBe(false));
    fireEvent.click(saveButton());

    await waitFor(() => expect(actions.createSpotlightAction).toHaveBeenCalledTimes(1));
    expect(actions.createSpotlightAction.mock.calls[0][0]).toMatchObject({
      companyName: "株式会社サンプル",
      personName: "山田 太郎",
      photoMediaId: "img_new",
      logoMediaId: null,
    });
  });

  it("写真のアップロード中に別の人の編集へ切り替えても、その写真は切り替えた先の人に入らない", async () => {
    const finishUpload = holdUpload();
    render(<SpotlightsView spotlights={[yamada, sato]} />);
    const [first, second] = within(screen.getByRole("region", { name: "メンバー紹介一覧" })).getAllByRole("listitem");
    fireEvent.click(within(first).getByRole("button", { name: "編集" }));
    choosePhoto();
    fireEvent.click(within(second).getByRole("button", { name: "編集" }));

    await act(async () => finishUpload({ id: "img_new", type: "image" }));
    fireEvent.click(saveButton());

    await waitFor(() => expect(actions.updateSpotlightAction).toHaveBeenCalledTimes(1));
    expect(actions.updateSpotlightAction.mock.calls[0]).toEqual(["spt_sato", expect.objectContaining({ photoMediaId: null, revision: 0 })]);
  });

  it("編集では今の内容が入っていて、保存すると id と revision を付けて更新する", async () => {
    render(<SpotlightsView spotlights={[yamada]} />);
    fireEvent.click(screen.getByRole("button", { name: "編集" }));
    expect((screen.getByLabelText("会社名") as HTMLInputElement).value).toBe("株式会社サンプル");
    expect((screen.getByLabelText("タグ 2") as HTMLInputElement).value).toBe("Web");
    expect((screen.getByLabelText("タグ 3") as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("switch", { name: "サイネージに出す" }).getAttribute("aria-checked")).toBe("true");

    fireEvent.change(screen.getByLabelText("肩書き（任意）"), { target: { value: " " } });
    fireEvent.change(screen.getByLabelText("タグ 1"), { target: { value: "" } });
    fireEvent.click(saveButton());

    await waitFor(() => expect(actions.updateSpotlightAction).toHaveBeenCalledTimes(1));
    expect(actions.updateSpotlightAction.mock.calls[0]).toEqual([
      "spt_yamada",
      {
        companyName: "株式会社サンプル",
        personName: "山田 太郎",
        role: null,
        quote: "毎日が実験です",
        bio: "映像と Web を作っています",
        tags: ["Web"],
        photoMediaId: "img_yamada",
        logoMediaId: null,
        enabled: true,
        revision: 2,
      },
    ]);
    expect(await screen.findByText(SAVED)).toBeTruthy();
  });

  it("他の人が先に更新していた（conflict）ときは入力欄を開いたまま知らせ、一覧を読み込み直す", async () => {
    actions.updateSpotlightAction.mockResolvedValue({ error: { code: "conflict", message: "他の人が先に更新しました" } });
    render(<SpotlightsView spotlights={[yamada]} />);
    fireEvent.click(screen.getByRole("button", { name: "編集" }));
    fireEvent.click(saveButton());

    expect((await screen.findByRole("alert")).textContent).toBe("他の人が先に更新しました");
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("region", { name: "メンバー紹介を編集" })).toBeTruthy();
    expect(screen.queryByText(SAVED)).toBeNull();
  });

  it("削除は確認してから、その人の id で削除する", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<SpotlightsView spotlights={[yamada]} />);
    fireEvent.click(screen.getByRole("button", { name: "削除" }));

    expect(confirm).toHaveBeenCalledWith("「山田 太郎さん」を削除します。よろしいですか？");
    await waitFor(() => expect(actions.deleteSpotlightAction).toHaveBeenCalledWith("spt_yamada"));
    await waitFor(() => expect(router.refresh).toHaveBeenCalled());
  });
});
