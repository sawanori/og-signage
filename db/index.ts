/**
 * libSQL クライアントと drizzle の生成。
 *
 * createClient は呼び出し側が選んで渡す。Workers は `@libsql/client/web`、Node（スクリプト・テスト）は
 * `@libsql/client`。接続方式の最終調整は task_002 の結果で行う。
 */
import type { Client, Config } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import * as schema from "./schema";

export type CreateClient = (config: Config) => Client;

export function createDb(createClient: CreateClient, url: string, authToken?: string) {
  const client = createClient({ url, authToken });
  return { client, db: drizzle(client, { schema }) };
}

export type Db = ReturnType<typeof createDb>["db"];

export { schema };
