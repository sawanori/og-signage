/**
 * PUT /api/media/uploads/[uploadId]/parts/[n] — パート送信（開始したユーザーのみ）。
 * 本文はストリームのまま R2 に渡す（1 パート目だけ形式検査のために読み込む）。Content-Length 必須。
 */
import { withRole } from "../../../../../../../lib/auth";
import { getMediaBucket } from "../../../../../../../lib/r2";
import { getDb } from "../../../../../../../lib/runtime";
import { mediaErrorResponse, uploadPart } from "../../../../../../../lib/services/media";

type Context = { params: Promise<{ uploadId: string; n: string }> };

export const PUT = withRole("staff", async (request: Request, { params }: Context, user) => {
  const { uploadId, n } = await params;
  const length = request.headers.get("content-length");
  try {
    const part = await uploadPart(
      { db: getDb(), bucket: getMediaBucket() },
      user,
      uploadId,
      /^\d+$/.test(n) ? Number(n) : NaN,
      request.body,
      length !== null && /^\d+$/.test(length) ? Number(length) : null,
    );
    return Response.json(part);
  } catch (e) {
    return mediaErrorResponse(e);
  }
});
