import { createClient } from "@libsql/client";
import { migrate } from "drizzle-orm/libsql/migrator";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createDb, type Db } from "../../db/index";

/** マイグレーション済みの一時 libSQL ファイル（tests/db/schema.test.ts と同じ作り方） */
export async function openTempDb(): Promise<{ db: Db; close: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), "og-app-db-"));
  const { client, db } = createDb(createClient, pathToFileURL(join(dir, "test.db")).href);
  await migrate(db, { migrationsFolder: "db/migrations" });
  return {
    db,
    close: () => {
      client.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
