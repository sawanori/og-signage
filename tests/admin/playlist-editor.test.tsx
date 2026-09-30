// @vitest-environment jsdom
/**
 * 定期動画の設定のスライドショー（components/admin/playlist-editor.tsx。2026-09-27 ユーザー指示）。
 * 再生リストに写真のスライドショーを 1 つ入れられる（写真 1〜3 枚・写真ごとの秒数・合計 30 秒まで）。
 * 行の表示、追加（1 つまで）、秒数と合計・上限、保存で送る items の並び、変更の検出、サイネージで試す。
 * Server Actions・画面遷移・アップロードは差し替える。
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PlaylistEntry, VideosPageData } from "@/components/admin/media-types";

const actions = vi.hoisted(() => ({
  requestTestPlayAction: vi.fn(),
  saveDevicePlaybackAction: vi.fn(),
}));
const router = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }));
vi.mock("@/app/admin/_actions/playback", () => actions);
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/lib/client/upload", () => ({ uploadMedia: vi.fn(), UploadError: class UploadError extends Error {} }));

import { PlaylistEditor } from "@/components/admin/playlist-editor";
import { uploadMedia } from "@/lib/client/upload";

const SETTINGS = { revision: 3, enabled: true, intervalMinutes: 10, mode: "sequence" as const, volume: 80 };
const DEVICES = [{ id: "dev_1", name: "1F ラウンジ" }];

const videoA: PlaylistEntry = {
  kind: "video",
  itemId: "itm_a",
  mediaId: "vid_a",
  name: "welcome.mp4",
  durationSeconds: 20,
  thumbnailUrl: "/api/media/vid_a/thumbnail",
};
const videoB: PlaylistEntry = {
  kind: "video",
  itemId: "itm_b",
  mediaId: "vid_b",
  name: "event.mp4",
  durationSeconds: 15,
  thumbnailUrl: null,
};
const slideshow: PlaylistEntry = {
  kind: "slideshow",
  itemId: "itm_s",
  slides: [
    { mediaId: "img_1", durationSeconds: 10, thumbnailUrl: "/api/media/img_1/thumbnail" },
    { mediaId: "img_2", durationSeconds: 5, thumbnailUrl: "/api/media/img_2/thumbnail" },
  ],
};

function pageData(items: PlaylistEntry[]): VideosPageData {
  return {
    deviceId: "dev_1",
    settings: SETTINGS,
    playlist: { id: "pl_1", revision: 7, items },
    library: [
      { mediaId: "vid_a", name: "welcome.mp4", durationSeconds: 20, thumbnailUrl: null, playable: true },
      { mediaId: "vid_b", name: "event.mp4", durationSeconds: 15, thumbnailUrl: null, playable: true },
      { mediaId: "vid_c", name: "night.mp4", durationSeconds: 12, thumbnailUrl: null, playable: true },
      { mediaId: "vid_d", name: "lunch.mp4", durationSeconds: 18, thumbnailUrl: null, playable: true },
      { mediaId: "vid_e", name: "talk.mp4", durationSeconds: 25, thumbnailUrl: null, playable: true },
    ],
  };
}

const renderEditor = (items: PlaylistEntry[]) => render(<PlaylistEditor data={pageData(items)} devices={DEVICES} />);
const playlistRows = () =>
  within(screen.getByRole("list", { name: "再生リスト（ドラッグで並べ替え）" })).getAllByRole("listitem");
const slideshowRow = () => {
  const row = playlistRows().find((li) => within(li).queryByText("スライドショー"));
  if (!row) throw new Error("スライドショーの行がありません");
  return row;
};
const slidesToggle = () => screen.getByRole("button", { name: "スライドショーの写真と秒数を編集" });
const openSlides = () => fireEvent.click(slidesToggle());
const slidesPanel = () => screen.getByRole("region", { name: "スライドショーの写真と秒数" });
const saveButton = () => screen.getByRole("button", { name: "保存する" }) as HTMLButtonElement;
const addSlideshowButton = () => screen.getByRole("button", { name: "スライドショーを追加" }) as HTMLButtonElement;
const ONLY_ONE =
  "スライドショーは再生リストに 1 つまでです。写真や秒数は、左の「スライドショーの写真と秒数を編集」から変えられます。";

beforeEach(() => {
  vi.clearAllMocks();
  actions.saveDevicePlaybackAction.mockResolvedValue({ ok: true, data: { settings: {}, playlist: null } });
  actions.requestTestPlayAction.mockResolvedValue({ ok: true, data: { testPlayRequestedAt: 1_790_000_000, testPlayMediaId: "img_1" } });
  vi.mocked(uploadMedia).mockResolvedValue({ id: "img_new", type: "image" } as Awaited<ReturnType<typeof uploadMedia>>);
});
afterEach(() => {
  cleanup();
});

describe("スライドショーの行", () => {
  it("写真の小さなサムネイル・枚数・合計秒数を出す。すでにあるので「スライドショーを追加」は押せず、理由を出す", () => {
    renderEditor([videoA, slideshow]);

    const [first, second] = playlistRows();
    expect(within(first).getByText("welcome.mp4")).toBeTruthy();
    expect(within(second).getByText("スライドショー")).toBeTruthy();
    expect(within(second).getByText("写真 2 枚・合計 15 秒")).toBeTruthy();
    expect([...second.querySelectorAll("img")].map((img) => img.getAttribute("src"))).toEqual([
      "/api/media/img_1/thumbnail",
      "/api/media/img_2/thumbnail",
    ]);
    expect(within(second).queryByText("未保存")).toBeNull();
    expect(screen.getByText("動画 1 / 5 本")).toBeTruthy();
    expect(screen.getByText("スライドショー 1 / 1")).toBeTruthy();

    // 写真の欄は閉じていて、合計だけを出す。開くと写真ごとの欄が出る
    expect(slidesToggle().getAttribute("aria-expanded")).toBe("false");
    expect(within(slidesPanel()).getByText("合計 15 / 30 秒")).toBeTruthy();
    expect(within(slidesPanel()).queryByLabelText("写真 1")).toBeNull();
    openSlides();
    expect(slidesToggle().getAttribute("aria-expanded")).toBe("true");
    expect((within(slidesPanel()).getByLabelText("写真 2 の秒数") as HTMLSelectElement).value).toBe("5");
    expect([...slidesPanel().querySelectorAll("img")].map((img) => img.getAttribute("src"))).toEqual([
      "/api/media/img_1/thumbnail",
      "/api/media/img_2/thumbnail",
    ]);

    expect(addSlideshowButton().disabled).toBe(true);
    expect(screen.getByText(ONLY_ONE)).toBeTruthy();
    // 保存済みのままなので保存するものは無い
    expect(saveButton().disabled).toBe(true);
    expect(
      screen.getByRole("img", {
        name: /動画またはスライドショーを 1 つずつ全画面で流します。動画は 5 本まで、スライドショーは 1 つ（写真 3 枚まで・合計 30 秒まで）/,
      }),
    ).toBeTruthy();
  });

  it("スライドショーは動画の本数（5 本まで）に数えない", () => {
    renderEditor([videoA, slideshow, videoB]);
    const library = screen.getByRole("region", { name: "動画を追加" });
    for (const name of ["night.mp4", "lunch.mp4", "talk.mp4"]) {
      const row = within(library).getByText(name).closest("li");
      if (!row) throw new Error(`${name} の行がありません`);
      fireEvent.click(within(row).getByRole("button", { name: "追加" }));
    }

    expect(playlistRows()).toHaveLength(6);
    expect(screen.getByText("動画 5 / 5 本")).toBeTruthy();
    expect(within(library).getByText(/再生する動画は 5 本までです/)).toBeTruthy();
  });
});

describe("スライドショーを追加", () => {
  it("1 つ足すと写真の欄が開き、写真を選ぶまでは保存できない。選ぶと写真と秒数（既定 10 秒）を送る", async () => {
    renderEditor([videoA]);
    expect(addSlideshowButton().disabled).toBe(false);
    expect(screen.queryByText(ONLY_ONE)).toBeNull();

    fireEvent.click(addSlideshowButton());
    expect(addSlideshowButton().disabled).toBe(true);
    expect(screen.getByText(ONLY_ONE)).toBeTruthy();

    const row = slideshowRow();
    expect(playlistRows()[1]).toBe(row);
    expect(slidesToggle().getAttribute("aria-expanded")).toBe("true");
    expect(within(row).getByText("写真 0 枚・合計 0 秒")).toBeTruthy();
    expect(within(row).getByText("未保存")).toBeTruthy();
    expect((within(row).getByRole("button", { name: "サイネージで再生" }) as HTMLButtonElement).disabled).toBe(true);
    expect(saveButton().disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toBe(
      "スライドショーの写真を 1 枚以上選んでください（写真を入れないときは、スライドショーを外してください）",
    );

    fireEvent.change(within(slidesPanel()).getByLabelText("写真 1"), {
      target: { files: [new File(["x"], "lounge.jpg", { type: "image/jpeg" })] },
    });
    await waitFor(() => expect(within(row).getByText("写真 1 枚・合計 10 秒")).toBeTruthy());
    expect(row.querySelector("img")?.getAttribute("src")).toBe("/api/media/img_new/thumbnail");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(saveButton().disabled).toBe(false);

    fireEvent.click(saveButton());
    await waitFor(() => expect(actions.saveDevicePlaybackAction).toHaveBeenCalledTimes(1));
    expect(actions.saveDevicePlaybackAction.mock.calls[0][1].playlist).toEqual({
      revision: 7,
      items: [
        { kind: "video", mediaId: "vid_a" },
        { kind: "slideshow", slides: [{ mediaId: "img_new", durationSeconds: 10 }] },
      ],
    });
  });

  it("外すと、また「スライドショーを追加」を押せる", () => {
    renderEditor([slideshow]);
    fireEvent.click(within(slideshowRow()).getByRole("button", { name: "外す" }));
    expect(addSlideshowButton().disabled).toBe(false);
    expect(screen.queryByText(ONLY_ONE)).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });
});

describe("写真の秒数と合計", () => {
  it("秒数を変えると合計が変わり、30 秒を超えると理由を出して保存できない", () => {
    renderEditor([videoA, slideshow]);
    openSlides();
    const panel = slidesPanel();
    expect(within(panel).getByText("合計 15 / 30 秒")).toBeTruthy();

    fireEvent.change(within(panel).getByLabelText("写真 1 の秒数"), { target: { value: "30" } });
    expect(within(panel).getByText("合計 35 / 30 秒").getAttribute("data-over")).toBe("true");
    expect(within(slideshowRow()).getByText("写真 2 枚・合計 35 秒")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toBe(
      "スライドショーは合計 30 秒までです（今は 35 秒）。写真の秒数を短くしてください",
    );
    expect(saveButton().disabled).toBe(true);
    fireEvent.click(saveButton());
    expect(actions.saveDevicePlaybackAction).not.toHaveBeenCalled();

    fireEvent.change(within(panel).getByLabelText("写真 1 の秒数"), { target: { value: "25" } });
    expect(within(panel).getByText("合計 30 / 30 秒").getAttribute("data-over")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(saveButton().disabled).toBe(false);
  });

  it("写真・並び・秒数を変えたときだけ保存できる（写真の無い欄を足しただけでは変わらない）", () => {
    renderEditor([slideshow]);
    openSlides();
    const panel = slidesPanel();

    fireEvent.change(within(panel).getByLabelText("写真 2 の秒数"), { target: { value: "15" } });
    expect(saveButton().disabled).toBe(false);
    expect(within(slideshowRow()).getByText("未保存")).toBeTruthy();
    fireEvent.change(within(panel).getByLabelText("写真 2 の秒数"), { target: { value: "5" } });
    expect(saveButton().disabled).toBe(true);
    expect(within(slideshowRow()).queryByText("未保存")).toBeNull();

    fireEvent.click(within(panel).getByRole("button", { name: "写真を追加" }));
    expect((within(panel).getByLabelText("写真 3 の秒数") as HTMLSelectElement).value).toBe("10");
    expect(within(panel).getByText(/写真を選んでいない欄は保存しません/)).toBeTruthy();
    expect((within(panel).getByRole("button", { name: "写真を追加" }) as HTMLButtonElement).disabled).toBe(true);
    expect(saveButton().disabled).toBe(true);

    // 1 枚目の欄を消すと、写真の並びが変わる
    fireEvent.click(within(panel).getByRole("button", { name: "写真 1 の欄を消す" }));
    expect(within(slideshowRow()).getByText("写真 1 枚・合計 5 秒")).toBeTruthy();
    expect(saveButton().disabled).toBe(false);
  });
});

describe("保存とサイネージで試す", () => {
  it("画面の並びのまま、動画は mediaId、スライドショーは写真と秒数（写真を選んだ欄だけ）を送る", async () => {
    renderEditor([videoA, slideshow, videoB]);
    fireEvent.keyDown(screen.getByRole("button", { name: "スライドショー の順番（上下キーで移動）" }), { key: "ArrowUp" });
    expect(playlistRows()[0]).toBe(slideshowRow());

    openSlides();
    const panel = slidesPanel();
    fireEvent.change(within(panel).getByLabelText("写真 2 の秒数"), { target: { value: "7" } });
    fireEvent.click(within(panel).getByRole("button", { name: "写真を追加" }));
    fireEvent.click(saveButton());

    await waitFor(() => expect(actions.saveDevicePlaybackAction).toHaveBeenCalledTimes(1));
    expect(actions.saveDevicePlaybackAction.mock.calls[0]).toEqual([
      "dev_1",
      {
        settings: { revision: 3, enabled: true, intervalMinutes: 10, mode: "sequence", volume: 80 },
        playlist: {
          revision: 7,
          items: [
            {
              kind: "slideshow",
              slides: [
                { mediaId: "img_1", durationSeconds: 10 },
                { mediaId: "img_2", durationSeconds: 7 },
              ],
            },
            { kind: "video", mediaId: "vid_a" },
            { kind: "video", mediaId: "vid_b" },
          ],
        },
      },
    ]);
    expect(await screen.findByText("保存しました。次の同期でサイネージに反映されます")).toBeTruthy();
    expect(router.refresh).toHaveBeenCalled();
  });

  it("保存済みのスライドショーは 1 枚目の写真を指定してサイネージで試せる。中身を変えたら保存するまで試せない", async () => {
    renderEditor([videoA, slideshow]);
    const testButton = within(slideshowRow()).getByRole("button", { name: "サイネージで再生" }) as HTMLButtonElement;
    fireEvent.click(testButton);

    await waitFor(() => expect(actions.requestTestPlayAction).toHaveBeenCalledWith("dev_1", "img_1"));
    expect(await screen.findByText("「スライドショー」をサイネージで再生します（数秒で始まります）")).toBeTruthy();

    openSlides();
    fireEvent.change(within(slidesPanel()).getByLabelText("写真 1 の秒数"), { target: { value: "5" } });
    expect(testButton.disabled).toBe(true);
    expect(testButton.title).toBe("保存してから再生できます");
  });

  it("他の人が先に更新していた（conflict）ときは知らせ、入力は画面に残す", async () => {
    actions.saveDevicePlaybackAction.mockResolvedValue({ ok: false, error: { code: "conflict", message: "conflict" } });
    renderEditor([slideshow]);
    openSlides();
    fireEvent.change(within(slidesPanel()).getByLabelText("写真 1 の秒数"), { target: { value: "15" } });
    fireEvent.click(saveButton());

    expect((await screen.findByRole("alert")).textContent).toContain("他の人が先に更新しました");
    expect(within(slideshowRow()).getByText("写真 2 枚・合計 20 秒")).toBeTruthy();
    expect(screen.getByRole("button", { name: "最新の内容を読み込む" })).toBeTruthy();
  });
});
