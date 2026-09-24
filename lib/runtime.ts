/**
 * Workers 実行時の DB 接続。Turso へは `@libsql/client/web` で接続する（docs/spikes/workers.md 2 節）。
 */
import { createClient } from "@libsql/client/web";
import { env } from "cloudflare:workers";
import { createDb, type Db } from "../db/index";

export function getDb(): Db {
  return createDb(createClient, env.TURSO_DATABASE_URL, env.TURSO_AUTH_TOKEN).db;
}
