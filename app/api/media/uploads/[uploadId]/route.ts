/** DELETE /api/media/uploads/[uploadId] — 中断（開始したユーザーのみ） */
import { withRole } from "../../../../../lib/auth";
import { getMediaBucket } from "../../../../../lib/r2";
import { getDb } from "../../../../../lib/runtime";
import { abortUpload, mediaErrorResponse } from "../../../../../lib/services/media";

type Context = { params: Promise<{ uploadId: string }> };

export const DELETE = withRole("staff", async (_request: Request, { params }: Context, user) => {
  const { uploadId } = await params;
  try {
    await abortUpload({ db: getDb(), bucket: getMediaBucket() }, user, uploadId);
    return Response.json({ ok: true });
  } catch (e) {
    return mediaErrorResponse(e);
  }
});
