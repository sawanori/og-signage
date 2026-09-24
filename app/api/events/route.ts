/** GET/POST /api/events（Staff 以上）。実装計画 9 節 */
import { withRole } from "../../../lib/auth";
import { getDb } from "../../../lib/runtime";
import { createEvent, eventErrorResponse, listEvents, readJson } from "../../../lib/services/events";

export const GET = withRole("staff", async (request: Request) => {
  try {
    const events = await listEvents(getDb(), Object.fromEntries(new URL(request.url).searchParams));
    return Response.json({ events });
  } catch (e) {
    return eventErrorResponse(e);
  }
});

export const POST = withRole("staff", async (request: Request) => {
  try {
    const event = await createEvent(getDb(), await readJson(request));
    return Response.json({ event }, { status: 201 });
  } catch (e) {
    return eventErrorResponse(e);
  }
});
