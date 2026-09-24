/**
 * POST /api/media/uploads/[uploadId]/complete — 完了（冪等。開始したユーザーのみ）。
 * multipart/form-data: `meta`（JSON。lib/services/media.ts の completeUploadSchema）、`thumbnail`（任意。WebP など）。
 */
import { withRole } from "../../../../../../lib/auth";
import { getMediaBucket } from "../../../../../../lib/r2";
import { getDb } from "../../../../../../lib/runtime";
import { MediaError, completeUpload, mediaErrorResponse, toMediaDto, type CompleteUploadInput } from "../../../../../../lib/services/media";

type Context = { params: Promise<{ uploadId: string }> };

export const POST = withRole("staff", async (request: Request, { params }: Context, user) => {
  const { uploadId } = await params;
  try {
    const form = await request.formData().catch(() => null);
    const metaText = form?.get("meta");
    if (typeof metaText !== "string") throw new MediaError(400, "invalid_input", "入力が正しくありません");
    let meta: unknown; // completeUpload が Zod で検証する
    try {
      meta = JSON.parse(metaText);
    } catch {
      throw new MediaError(400, "invalid_input", "入力が正しくありません");
    }
    const thumb = form?.get("thumbnail");
    const thumbnail = thumb instanceof Blob ? new Uint8Array(await thumb.arrayBuffer()) : null;

    const row = await completeUpload({ db: getDb(), bucket: getMediaBucket() }, user, uploadId, meta as CompleteUploadInput, thumbnail);
    return Response.json({ media: toMediaDto(row) });
  } catch (e) {
    return mediaErrorResponse(e);
  }
});
