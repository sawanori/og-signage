// @vitest-environment jsdom
import { Blob as NodeBlob } from "node:buffer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { prepareSpotlightImage } from "@/lib/client/prepare-spotlight-image";
import { SPOTLIGHT_SUBMISSION_MAX_FILE_BYTES, SPOTLIGHT_SUBMISSION_MAX_SOURCE_BYTES, SPOTLIGHT_SUBMISSION_TARGET_IMAGE_BYTES } from "@/lib/spotlight-submissions";

const drawImage = vi.fn();
const close = vi.fn();
const bitmap = vi.fn();
const jpeg = () => new NodeBlob([new Uint8Array([0xff, 0xd8, 0xff, 0])], { type: "image/jpeg" }) as Blob;
const sized = (bytes: number, type: string) => new Blob([new Uint8Array(bytes)], { type });
type Encode = (this: HTMLCanvasElement, callback: BlobCallback, type?: string, quality?: number) => void;
const mockEncode = (encode: Encode) => vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(encode);

beforeEach(() => {
  vi.stubGlobal("createImageBitmap", bitmap.mockResolvedValue({ width: 4000, height: 3000, close }));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe("本人登録の画像準備", () => {
  it("EXIFの向きを反映して長辺1280pxへ縮小し、画像を解放する", async () => {
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => callback(new Blob(["webp"], { type: "image/webp" })));
    const file = jpeg();
    const result = await prepareSpotlightImage(file, "photo");
    expect(bitmap).toHaveBeenCalledWith(file, { imageOrientation: "from-image" });
    expect(result).toMatchObject({ width: 1280, height: 960 });
    expect(result.blob.type).toBe("image/webp");
    expect(drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 1280, 960);
    expect(close).toHaveBeenCalledOnce();
  });

  it.each([["photo", "image/jpeg"], ["logo", "image/png"]] as const)("WebP非対応でも%sを%sで準備できる", async (kind, fallback) => {
    const encode = vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback, mime) =>
      callback(new Blob(["image"], { type: mime === "image/webp" ? "image/png" : mime })),
    );
    const result = await prepareSpotlightImage(jpeg(), kind);
    expect(result.blob.type).toBe(fallback);
    expect(encode).toHaveBeenLastCalledWith(expect.any(Function), fallback, 0.85);
  });

  it("約400KBを超えたら画質を下げて収める", async () => {
    const encode = mockEncode((callback, type, quality) =>
      callback(sized(quality === 0.85 ? SPOTLIGHT_SUBMISSION_TARGET_IMAGE_BYTES + 1 : SPOTLIGHT_SUBMISSION_TARGET_IMAGE_BYTES, type!)),
    );
    const result = await prepareSpotlightImage(jpeg(), "photo");
    expect(result).toMatchObject({ width: 1280, height: 960 });
    expect(result.blob.size).toBe(SPOTLIGHT_SUBMISSION_TARGET_IMAGE_BYTES);
    expect(encode.mock.calls.map(([, type, quality]) => [type, quality])).toEqual([["image/webp", 0.85], ["image/webp", 0.75]]);
  });

  it("画質を下げても大きければ寸法を縮める", async () => {
    mockEncode(function (callback, type) {
      callback(sized(this.width > 960 ? SPOTLIGHT_SUBMISSION_TARGET_IMAGE_BYTES * 2 : 1000, type!));
    });
    const result = await prepareSpotlightImage(jpeg(), "photo");
    expect(result).toMatchObject({ width: 960, height: 720 });
    expect(drawImage).toHaveBeenLastCalledWith(expect.anything(), 0, 0, 960, 720);
  });

  it("WebP非対応のロゴはPNGのまま、画質ではなく寸法だけで縮める", async () => {
    const encode = mockEncode(function (callback, type) {
      if (type === "image/webp") return callback(sized(10, "image/png"));
      callback(sized(this.width > 720 ? SPOTLIGHT_SUBMISSION_TARGET_IMAGE_BYTES * 2 : 1000, type!));
    });
    const result = await prepareSpotlightImage(jpeg(), "logo");
    expect(result).toMatchObject({ width: 720, height: 540 });
    expect(result.blob.type).toBe("image/png");
    // WebP の確認は最初の1回だけ。PNG は寸法ごとに1回（1280 → 960 → 720）
    expect(encode.mock.calls.map(([, type]) => type)).toEqual(["image/webp", "image/png", "image/png", "image/png"]);
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
