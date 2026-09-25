// @vitest-environment jsdom
/**
 * メディア一覧から画像を選ぶ（components/admin/media-picker.tsx。2026-09-25 ユーザー指示）。
 * 一覧は GET /api/media の画像だけ。選ぶと mediaId とプレビュー URL を返して閉じる。
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MediaPickerButton } from "@/components/admin/media-picker";

beforeEach(() => {
  // jsdom の <dialog> には showModal・close が無いので最小限を足す
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({
        media: [
          { id: "img_logo", name: "logo.png", type: "image", width: 400, height: 200 },
          { id: "vid_a", name: "welcome.mp4", type: "video", width: 1920, height: 1080 },
          { id: "img_room", name: "lounge.jpg", type: "image", width: 1600, height: 1200 },
        ],
      }),
    ),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MediaPickerButton", () => {
  it("アップロード済みの画像だけを出し、選ぶと mediaId とプレビュー URL を返して閉じる", async () => {
    const onPick = vi.fn();
    render(<MediaPickerButton className="b" selectedId="img_logo" onPick={onPick} />);
    fireEvent.click(screen.getByRole("button", { name: "メディア一覧から選ぶ" }));

    await waitFor(() => expect(screen.getByTitle("lounge.jpg")).toBeTruthy());
    expect(screen.queryByTitle("welcome.mp4")).toBeNull();
    expect(screen.getByTitle("logo.png").getAttribute("aria-pressed")).toBe("true");

    fireEvent.click(screen.getByTitle("lounge.jpg"));
    expect(onPick).toHaveBeenCalledWith("img_room", "/api/media/img_room/thumbnail");
    expect(document.querySelector("dialog")?.hasAttribute("open")).toBe(false);
  });

  it("画像が無ければ、アップロードの案内を出す", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ media: [] })));
    render(<MediaPickerButton className="b" onPick={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "メディア一覧から選ぶ" }));
    await waitFor(() => expect(screen.getByText(/画像がまだありません/)).toBeTruthy());
  });
});
