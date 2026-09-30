// @vitest-environment jsdom
import { Blob as NodeBlob } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareSpotlightImage } from "@/lib/client/prepare-spotlight-image";
import { SPOTLIGHT_SUBMISSION_MAX_FILE_BYTES, SPOTLIGHT_SUBMISSION_MAX_SOURCE_BYTES } from "@/lib/spotlight-submissions";

const drawImage = vi.fn();
const close = vi.fn();
const bitmap = vi.fn();
const jpeg = () => new NodeBlob([new Uint8Array([0xff, 0xd8, 0xff, 0])], { type: "image/jpeg" }) as Blob;

beforeEach(() => {
  vi.stubGlobal("createImageBitmap", bitmap.mockResolvedValue({ width: 4000, height: 3000, close }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("本人登録の画像準備", () => {
  it("EXIFの向きを反映して長辺1920pxへ縮小し、画像を解放する", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => callback(new Blob(["webp"], { type: "image/webp" })));
    const file = jpeg();
    const result = await prepareSpotlightImage(file, "photo");
    expect(bitmap).toHaveBeenCalledWith(file, { imageOrientation: "from-image" });
    expect(result).toMatchObject({ width: 1920, height: 1440 });
    expect(result.blob.type).toBe("image/webp");
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1920, 1440);
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([["photo", "image/jpeg"], ["logo", "image/png"]] as const)("WebP非対応でも%sを%sで準備できる", async (kind, fallback) => {
    const encode = vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback, mime) =>
      callback(new Blob(["image"], { type: mime === "image/webp" ? "image/png" : mime })),
    );
    const result = await prepareSpotlightImage(jpeg(), kind);
    expect(result.blob.type).toBe(fallback);
    expect(encode).toHaveBeenLastCalledWith(expect.any(Function), fallback, 0.9);
  });

  it("変換後2MiB超の画像は送らず、別画像を選ぶ説明を返す", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) =>
      callback(new Blob([new Uint8Array(SPOTLIGHT_SUBMISSION_MAX_FILE_BYTES + 1)], { type: "image/webp" })),
    );
    await expect(prepareSpotlightImage(jpeg(), "photo")).rejects.toThrow("2MB");
    expect(close).toHaveBeenCalledOnce();
  });

  it("元画像20MiB超・未対応形式はデコードせず拒否する", async () => {
    await expect(prepareSpotlightImage(new NodeBlob([new Uint8Array(SPOTLIGHT_SUBMISSION_MAX_SOURCE_BYTES + 1)]) as Blob, "photo")).rejects.toThrow("20MB");
    await expect(prepareSpotlightImage(new NodeBlob(["<svg/>"]) as Blob, "logo")).rejects.toThrow("JPEG");
    expect(bitmap).not.toHaveBeenCalled();
  });

  it("画像読取失敗・出力失敗を日本語で知らせる", async () => {
    bitmap.mockRejectedValueOnce(new Error("decode"));
    await expect(prepareSpotlightImage(jpeg(), "photo")).rejects.toThrow("読み込めません");
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => callback(null));
    await expect(prepareSpotlightImage(jpeg(), "photo")).rejects.toThrow("処理できません");
    expect(close).toHaveBeenCalledOnce();
  });
});
