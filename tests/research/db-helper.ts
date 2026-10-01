import { createClient } from "@libsql/client";
import { migrate } from "drizzle-orm/libsql/migrator";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openResearchDatabase } from "../../research/db/client";

export async function openTestResearchDatabase() {
  const dir = mkdtempSync(join(tmpdir(), "og-research-"));
  const url = pathToFileURL(join(dir, "research.db")).href;
  const connection = openResearchDatabase({ RESEARCH_DATABASE_URL: url }, createClient);
  await migrate(connection.db, { migrationsFolder: "research/db/migrations" });
  return { ...connection, url, openAnother: () => openResearchDatabase({ RESEARCH_DATABASE_URL: url }, createClient), close() { connection.close(); rmSync(dir, { recursive: true, force: true }); } };
}
