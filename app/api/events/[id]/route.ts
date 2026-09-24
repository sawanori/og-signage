/** GET/PUT/DELETE /api/events/[id]（Staff 以上）。PUT は revision 必須、不一致は 409。実装計画 9 節 */
import { withRole } from "../../../../lib/auth";
import { getDb } from "../../../../lib/runtime";
import { deleteEvent, eventErrorResponse, getEvent, readJson, updateEvent } from "../../../../lib/services/events";

type Context = { params: Promise<{ id: string }> };

export const GET = withRole("staff", async (_request: Request, { params }: Context) => {
  try {
    const event = await getEvent(getDb(), (await params).id);
    return Response.json({ event });
  } catch (e) {
    return eventErrorResponse(e);
  }
});

export const PUT = withRole("staff", async (request: Request, { params }: Context) => {
  try {
    const event = await updateEvent(getDb(), (await params).id, await readJson(request));
    return Response.json({ event });
  } catch (e) {
    return eventErrorResponse(e);
  }
});

export const DELETE = withRole("staff", async (_request: Request, { params }: Context) => {
  try {
    await deleteEvent(getDb(), (await params).id);
    return new Response(null, { status: 204 });
  } catch (e) {
    return eventErrorResponse(e);
  }
});
