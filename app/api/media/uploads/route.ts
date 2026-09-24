/** POST /api/media/uploads — 開始。`{ kind, size }` を受け、`{ uploadId, partSize }` を返す */
import { withRole } from "../../../../lib/auth";
import { getMediaBucket } from "../../../../lib/r2";
import { getDb } from "../../../../lib/runtime";
import { mediaErrorResponse, startUpload } from "../../../../lib/services/media";

export const POST = withRole("staff", async (request: Request, _context: unknown, user) => {
  try {
    const input = await request.json().catch(() => null);
    const result = await startUpload({ db: getDb(), bucket: getMediaBucket() }, user, input);
    return Response.json(result, { status: 201 });
  } catch (e) {
    return mediaErrorResponse(e);
  }
});
