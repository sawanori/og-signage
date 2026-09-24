/**
 * 先頭バイトによる形式の判定。拡張子・Content-Type は信用しない。
 *
 * 受け付けるのは JPEG / PNG / WebP / MP4 だけ。SVG・GIF・HEIC などは null（拒否）。
 */

export type SniffedMime = "image/jpeg" | "image/png" | "image/webp" | "video/mp4";
export type MediaKind = "image" | "video";

/** 1 ファイルの上限（計画 6 節 7）。ブラウザとサーバーで共通 */
export const MEDIA_MAX_BYTES: Record<MediaKind, number> = {
  image: 20 * 1024 * 1024,
  video: 500 * 1024 * 1024,
};

/** マルチパートの 1 パート（最後のパート以外はこの大きさちょうど） */
export const UPLOAD_PART_SIZE = 10 * 1024 * 1024;

/** 判定に必要な先頭バイト数 */
export const SNIFF_BYTES = 16;

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

/** MP4（ISO BMFF）として扱う major brand。HEIC/AVIF（heic, mif1, avif など）は含めない */
const MP4_BRANDS = new Set(["isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V ", "M4VP", "dash", "MSNV", "3gp4", "3gp5", "3g2a"]);

export function sniffMime(head: Uint8Array): SniffedMime | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (
    head.length >= 8 &&
    head[0] === 0x89 &&
    ascii(head, 1, 3) === "PNG" &&
    head[4] === 0x0d &&
    head[5] === 0x0a &&
    head[6] === 0x1a &&
    head[7] === 0x0a
  ) {
    return "image/png";
  }
  if (head.length >= 12 && ascii(head, 0, 4) === "RIFF" && ascii(head, 8, 4) === "WEBP") return "image/webp";
  if (head.length >= 12 && ascii(head, 4, 4) === "ftyp" && MP4_BRANDS.has(ascii(head, 8, 4))) return "video/mp4";
  return null;
}

export function kindOfMime(mime: SniffedMime): MediaKind {
  return mime === "video/mp4" ? "video" : "image";
}
