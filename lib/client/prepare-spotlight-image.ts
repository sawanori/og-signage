import { SNIFF_BYTES, sniffMime } from "../file-sniff";
import {
  SPOTLIGHT_SUBMISSION_MAX_FILE_BYTES,
  SPOTLIGHT_SUBMISSION_MAX_IMAGE_EDGE,
  SPOTLIGHT_SUBMISSION_MAX_SOURCE_BYTES,
  type SpotlightSubmissionImageKind,
} from "../spotlight-submissions";

/** 公開フォーム用。画像はローカルで準備し、送信が確定するまでは同じBlobを保持する。 */
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
    const scale = Math.min(1, SPOTLIGHT_SUBMISSION_MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("画像を処理できませんでした。別の画像をお選びください。");
    context.drawImage(bitmap, 0, 0, width, height);
    const encode = (type: string) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.9));
    let blob = await encode("image/webp");
    if (blob && blob.type !== "image/webp") blob = await encode(kind === "photo" ? "image/jpeg" : "image/png");
    if (!blob || !["image/webp", "image/jpeg", "image/png"].includes(blob.type)) throw new Error("画像を処理できませんでした。別の画像をお選びください。");
    if (blob.size > SPOTLIGHT_SUBMISSION_MAX_FILE_BYTES) throw new Error("縮小後も画像が2MBを超えています。小さい画像をお選びください。");
    return { blob, width, height };
  } finally {
    bitmap.close();
  }
}
