/** GET /api/media — 一覧（削除予約中を除く） */
import { withRole } from "../../../lib/auth";
import { getDb } from "../../../lib/runtime";
import { listMedia, toMediaDto } from "../../../lib/services/media";

export const GET = withRole("staff", async () => {
  const rows = await listMedia(getDb());
  return Response.json({ media: rows.map(toMediaDto) });
});
