import { createClient as createWebClient } from "@libsql/client/web";
import type { Client, Config } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema";

export type ResearchDatabaseConfig = { RESEARCH_DATABASE_URL?: string; RESEARCH_AUTH_TOKEN?: string };
export function openResearchDatabase(config: ResearchDatabaseConfig, factory: (config: Config) => Client = createWebClient) {
  const url = config.RESEARCH_DATABASE_URL?.trim();
  if (!url) throw new Error("RESEARCH_DATABASE_URL is required; signage database fallback is forbidden");
  const client = factory({ url, authToken: config.RESEARCH_AUTH_TOKEN });
  const db = drizzle(client, { schema });
  return { client, db, close: () => client.close() };
}
export type ResearchDb = ReturnType<typeof openResearchDatabase>["db"];
export type ResearchTransaction = Parameters<Parameters<ResearchDb["transaction"]>[0]>[0];

/** Retry only local write-lock contention; network/commit ambiguity is handled by idempotency. */
export async function researchWrite<T>(db: ResearchDb, operation: (tx: ResearchTransaction) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await db.transaction(operation, { behavior: "immediate" }); }
    catch (error) {
      let current: unknown = error;
      let busy = false;
      while (current instanceof Error) {
        if ("code" in current && current.code === "SQLITE_BUSY") { busy = true; break; }
        current = current.cause;
      }
      if (!busy || attempt >= 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 20 * (attempt + 1)));
    }
  }
}
