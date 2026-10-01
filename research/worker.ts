import { openResearchDatabase } from "./db/client";
import type { ResearchEnv } from "./env";
import { handleIntake } from "./intake";
import { cancelInactiveResearchCrawls, runResearchTick } from "./jobs";
import { purgeResearchData } from "./retention";

export async function runResearchScheduled(env: ResearchEnv) {
  const connection = openResearchDatabase(env);
  try {
    await cancelInactiveResearchCrawls(connection.db, env);
    await purgeResearchData(connection.db, env.RESEARCH_BUCKET);
    return await runResearchTick(connection.db, env);
  } finally { connection.close(); }
}

const researchWorker = {
  async fetch(request: Request, env: ResearchEnv): Promise<Response> {
    if (new URL(request.url).pathname !== "/internal/sources") return new Response(null, { status: 404 });
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
    try {
      const connection = openResearchDatabase(env);
      try { return await handleIntake(request, connection.db); }
      finally { connection.close(); }
    } catch { return Response.json({ error: { code: "research_unavailable" } }, { status: 503 }); }
  },
  async scheduled(controller: { cron: string }, env: ResearchEnv, ctx: { waitUntil(promise: Promise<unknown>): void }): Promise<void> {
    if (controller.cron !== "* * * * *") return;
    ctx.waitUntil(runResearchScheduled(env).catch(() => { console.error("Research scheduled processing failed; retry remains durable"); }));
  },
};

export default researchWorker;
