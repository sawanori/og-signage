import { withRole } from "@/lib/auth";
import { getMediaBucket } from "@/lib/r2";
import { getDb } from "@/lib/runtime";
import { getSpotlightSubmissionImage, SpotlightSubmissionError } from "@/lib/services/spotlight-submissions";

type Context = { params: Promise<{ id: string; kind: string }> };

export const GET = withRole("staff", async (_request: Request, context: Context, user) => {
  try {
    const { id, kind } = await context.params;
    const { file, object } = await getSpotlightSubmissionImage(getDb(), getMediaBucket(), user, id, kind);
    return new Response(object.body, { headers: { "content-type": file.mimeType, "content-length": String(file.size), "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
  } catch (error) {
    if (error instanceof SpotlightSubmissionError) return Response.json({ error: { code: error.code, message: error.message } }, { status: error.status, headers: { "cache-control": "private, no-store" } });
    throw error;
  }
});
