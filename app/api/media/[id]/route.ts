/**
 * DELETE /api/media/[id] — 削除予約（参照中は 409）。R2 からの削除は Cron（task_013）。
 * 素材の取得（/api/media/[id]/file・/thumbnail）は worker/index.ts が vinext より前に処理する。
 */
import { withRole } from "../../../../lib/auth";
import { nowSeconds } from "../../../../db/schema";
import { getDb } from "../../../../lib/runtime";
import { mediaErrorResponse, requestMediaDeletion } from "../../../../lib/services/media";

type Context = { params: Promise<{ id: string }> };

export const DELETE = withRole("staff", async (_request: Request, { params }: Context) => {
  const { id } = await params;
  try {
    await requestMediaDeletion(getDb(), id, nowSeconds());
    return Response.json({ ok: true });
  } catch (e) {
    return mediaErrorResponse(e);
  }
});
