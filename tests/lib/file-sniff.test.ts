import { describe, expect, it } from "vitest";
import { kindOfMime, sniffMime } from "../../lib/file-sniff";

const bytes = (...parts: (string | number[])[]) =>
  new Uint8Array(parts.flatMap((p) => (typeof p === "string" ? [...p].map((c) => c.charCodeAt(0)) : p)));

const FIXTURE_HEADS = {
  jpeg: bytes([0xff, 0xd8, 0xff, 0xe0, 0, 0x10], "JFIF", [0, 1, 1, 0, 0, 1]),
  png: bytes([0x89], "PNG", [0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d], "IHDR"),
  webp: bytes("RIFF", [0x24, 0, 0, 0], "WEBPVP8 "),
  mp4: bytes([0, 0, 0, 0x20], "ftypisom", [0, 0, 2, 0]),
  mp4Mp42: bytes([0, 0, 0, 0x18], "ftypmp42", [0, 0, 0, 0]),
};

describe("sniffMime", () => {
  it("JPEG・PNG・WebP・MP4 を先頭バイトで判定する", () => {
    expect(sniffMime(FIXTURE_HEADS.jpeg)).toBe("image/jpeg");
    expect(sniffMime(FIXTURE_HEADS.png)).toBe("image/png");
    expect(sniffMime(FIXTURE_HEADS.webp)).toBe("image/webp");
    expect(sniffMime(FIXTURE_HEADS.mp4)).toBe("video/mp4");
    expect(sniffMime(FIXTURE_HEADS.mp4Mp42)).toBe("video/mp4");
  });

  it("SVG は拒否する（XML 宣言あり・なし）", () => {
    expect(sniffMime(bytes('<?xml version="1.0"?><svg'))).toBeNull();
    expect(sniffMime(bytes('<svg xmlns="http://www.w3.org/2000/svg">'))).toBeNull();
  });

  it("GIF・HEIC・AVIF・QuickTime・PDF・HTML・空は拒否する", () => {
    expect(sniffMime(bytes("GIF89a", [1, 0, 1, 0, 0, 0, 0, 0, 0, 0]))).toBeNull();
    expect(sniffMime(bytes([0, 0, 0, 0x18], "ftypheic", [0, 0, 0, 0]))).toBeNull();
    expect(sniffMime(bytes([0, 0, 0, 0x18], "ftypavif", [0, 0, 0, 0]))).toBeNull();
    expect(sniffMime(bytes([0, 0, 0, 0x14], "ftypqt  ", [0, 0, 0, 0]))).toBeNull();
    expect(sniffMime(bytes("%PDF-1.7\n%âãÏÓ\n"))).toBeNull();
    expect(sniffMime(bytes("<!doctype html><html>"))).toBeNull();
    expect(sniffMime(new Uint8Array())).toBeNull();
  });

  it("RIFF でも WEBP でなければ拒否する（WAV・AVI）", () => {
    expect(sniffMime(bytes("RIFF", [0x24, 0, 0, 0], "WAVEfmt "))).toBeNull();
    expect(sniffMime(bytes("RIFF", [0x24, 0, 0, 0], "AVI LIST"))).toBeNull();
  });

  it("途中で切れた先頭バイトは拒否する", () => {
    expect(sniffMime(FIXTURE_HEADS.png.subarray(0, 6))).toBeNull();
    expect(sniffMime(FIXTURE_HEADS.webp.subarray(0, 10))).toBeNull();
    expect(sniffMime(FIXTURE_HEADS.jpeg.subarray(0, 2))).toBeNull();
  });

  it("種類は MP4 だけが video", () => {
    expect(kindOfMime("video/mp4")).toBe("video");
    expect(kindOfMime("image/jpeg")).toBe("image");
    expect(kindOfMime("image/png")).toBe("image");
    expect(kindOfMime("image/webp")).toBe("image");
  });
});
