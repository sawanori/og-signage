// @vitest-environment jsdom
/**
 * 画像欄へのドラッグ＆ドロップ（components/admin/use-file-drop.ts。2026-09-25 ユーザー指示）。
 * ロゴ・フッター画像・お知らせ画像（MediaUploadField）とイベント画像（EventImageField）で、
 * 落とした画像をアップロードする。欄の外に落としたファイルはブラウザに開かせない。
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventImageField } from "@/components/admin/event-image-field";
import { MediaUploadField } from "@/components/admin/media-upload-field";
import { uploadMedia } from "@/lib/client/upload";

vi.mock("@/lib/client/upload", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/client/upload")>()),
  uploadMedia: vi.fn(),
}));

const photo = new File(["x"], "lounge.jpg", { type: "image/jpeg" });
const files = (...list: File[]) => ({ dataTransfer: { types: ["Files"], files: list } });

beforeEach(() => {
  vi.mocked(uploadMedia).mockResolvedValue({ id: "img_new", type: "image" } as Awaited<ReturnType<typeof uploadMedia>>);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("MediaUploadField のドラッグ＆ドロップ", () => {
  it("重ねているあいだは「ここにドロップ」を出し、落とした画像をアップロードして mediaId とプレビュー URL を返す", async () => {
    const onChange = vi.fn();
    render(<MediaUploadField label="ロゴ" previewUrl={null} onChange={onChange} />);
    const zone = screen.getByTestId("image-drop");

    fireEvent.dragEnter(zone, files(photo));
    expect(zone.getAttribute("data-over")).toBe("true");
    expect(screen.getByText("ここにドロップ")).toBeTruthy();

    fireEvent.drop(zone, files(photo));
    expect(zone.getAttribute("data-over")).toBeNull();
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("img_new", "/api/media/img_new/thumbnail"));
    expect(uploadMedia).toHaveBeenCalledWith(photo, expect.anything());
  });

  it("画像でないファイルは送らずに案内を出す", async () => {
    const onChange = vi.fn();
    render(<MediaUploadField label="ロゴ" previewUrl={null} onChange={onChange} />);
    fireEvent.drop(screen.getByTestId("image-drop"), files(new File(["x"], "memo.txt", { type: "text/plain" })));
    expect(await screen.findByText("画像は JPEG・PNG・WebP のファイルを選んでください")).toBeTruthy();
    expect(uploadMedia).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it("使えないとき（disabled）は重ねても反応せず、落としても送らない", () => {
    render(<MediaUploadField label="ロゴ" previewUrl={null} disabled onChange={() => {}} />);
    const zone = screen.getByTestId("image-drop");
    fireEvent.dragEnter(zone, files(photo));
    expect(zone.getAttribute("data-over")).toBeNull();
    fireEvent.drop(zone, files(photo));
    expect(uploadMedia).not.toHaveBeenCalled();
  });

  it("欄の外に落としたファイルはブラウザに開かせない（入力中の画面から離れない）", () => {
    render(<MediaUploadField label="ロゴ" previewUrl={null} onChange={() => {}} />);
    // fireEvent は既定の動作が止められたら false を返す
    expect(fireEvent.drop(document.body, files(photo))).toBe(false);
    expect(fireEvent.dragOver(document.body, files(photo))).toBe(false);
    expect(uploadMedia).not.toHaveBeenCalled();
  });
});

describe("EventImageField のドラッグ＆ドロップ", () => {
  it("落とした画像をアップロードして、イベント画像にする", async () => {
    const onUploaded = vi.fn();
    render(<EventImageField previewUrl={null} onUploaded={onUploaded} onRemove={() => {}} onBusyChange={() => {}} />);
    expect(screen.getByText("ここに画像をドラッグ＆ドロップできます")).toBeTruthy();
    const zone = screen.getByTestId("image-drop");

    fireEvent.dragEnter(zone, files(photo));
    expect(screen.getByText("ここにドロップ")).toBeTruthy();
    fireEvent.drop(zone, files(photo));
    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith("img_new", "/api/media/img_new/thumbnail"));
    expect(screen.queryByText("ここにドロップ")).toBeNull();
  });
});
