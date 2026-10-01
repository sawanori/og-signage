import { SNIFF_BYTES, sniffMime } from "../file-sniff";
import {
  SPOTLIGHT_SUBMISSION_MAX_FILE_BYTES,
  SPOTLIGHT_SUBMISSION_MAX_IMAGE_EDGE,
  SPOTLIGHT_SUBMISSION_MAX_SOURCE_BYTES,
  SPOTLIGHT_SUBMISSION_MIN_IMAGE_EDGE,
  SPOTLIGHT_SUBMISSION_TARGET_IMAGE_BYTES,
  type SpotlightSubmissionImageKind,
} from "../spotlight-submissions";

/** 目標の大きさを超えたら、この順に画質を下げる（PNG は画質を選べないので寸法だけで調整する） */
const QUALITIES = [0.85, 0.75, 0.65] as const;
const PROCESS_ERROR = "画像を処理できませんでした。別の画像をお選びください。";

/**
 * 公開フォーム用。画像はローカルで準備し、送信が確定するまでは同じBlobを保持する。
 * 選んだ時点で長辺1280pxまで縮め、1枚あたり約400KBに収まるまで画質を下げ、それでも大きければ寸法を縮める。
 */
export async function prepareSpotlightImage(file: Blob, kind: SpotlightSubmissionImageKind): Promise<{ blob: Blob; width: number; height: number }> {
  if (file.size > SPOTLIGHT_SUBMISSION_MAX_SOURCE_BYTES) throw new Error("元の画像は20MB以下にしてください。");
  const mime = sniffMime(new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer()));
  if (!mime || mime === "video/mp4") throw new Error("画像はJPEG・PNG・WebPを選んでください。HEICはJPEGで保存してからお選びください。");

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error("画像を読み込めませんでした。別のJPEG・PNG・WebP画像をお選びください。");
  }
  try {
    const longEdge = Math.max(bitmap.width, bitmap.height);
    let edge = Math.min(SPOTLIGHT_SUBMISSION_MAX_IMAGE_EDGE, longEdge);
    // WebP を出力できないブラウザ（Canvas は代わりに PNG を返す）では、写真は JPEG、透過のあるロゴは PNG にする
    let type: string | null = null;
    for (;;) {
      const width = Math.max(1, Math.round((bitmap.width * edge) / longEdge));
      const height = Math.max(1, Math.round((bitmap.height * edge) / longEdge));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error(PROCESS_ERROR);
      context.drawImage(bitmap, 0, 0, width, height);
      const encode = (format: string, quality: number) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, format, quality));

      let blob: Blob | null = null;
      for (const quality of QUALITIES) {
        if (type === null) {
          blob = await encode("image/webp", quality);
          type = blob?.type === "image/webp" ? "image/webp" : kind === "photo" ? "image/jpeg" : "image/png";
          if (type !== "image/webp") blob = await encode(type, quality);
        } else {
          blob = await encode(type, quality);
        }
        if (!blob || blob.type !== type) throw new Error(PROCESS_ERROR);
        if (blob.size <= SPOTLIGHT_SUBMISSION_TARGET_IMAGE_BYTES || type === "image/png") break;
      }
      if (!blob) throw new Error(PROCESS_ERROR);
      if (blob.size <= SPOTLIGHT_SUBMISSION_TARGET_IMAGE_BYTES || edge <= SPOTLIGHT_SUBMISSION_MIN_IMAGE_EDGE) {
        if (blob.size > SPOTLIGHT_SUBMISSION_MAX_FILE_BYTES) throw new Error("縮小後も画像が2MBを超えています。小さい画像をお選びください。");
        return { blob, width, height };
      }
      edge = Math.max(SPOTLIGHT_SUBMISSION_MIN_IMAGE_EDGE, Math.round(edge * 0.75));
    }
  } finally {
    bitmap.close();
  }
}
