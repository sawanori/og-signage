/** 空のローカルsqld専用。既存/本番DBを流用せず、本人登録の実ブラウザ検証データを作る。 */
import { createClient } from "@libsql/client";
import { migrate } from "drizzle-orm/libsql/migrator";
import { eq } from "drizzle-orm";
import { createDb } from "../../db/index";
import { displayBundles, users } from "../../db/schema";
import { seed } from "../../db/seed";
import { registerDevice } from "../../lib/services/devices";
import { createAdmin } from "../../scripts/create-admin";

const databaseUrl = process.env.E2E_DATABASE_URL;
const baseUrl = process.env.E2E_BASE_URL;
if (!databaseUrl || !baseUrl) throw new Error("E2E_DATABASE_URLとE2E_BASE_URLを指定してください");
for (const value of [databaseUrl, baseUrl]) {
  const url = new URL(value);
  if (url.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("ローカルHTTP接続だけが対象です");
}
const { db, client } = createDb(createClient, databaseUrl);
try {
  const existing = await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'");
  if (existing.rows.length) throw new Error("空の専用DBを使ってください。既存テーブルは削除しません");
  await migrate(db, { migrationsFolder: "db/migrations" });
  await seed(db);
  const userId = await createAdmin(db, { email: "member-e2e@example.test", name: "検証スタッフ", password: "local-member-e2e-only" });
  await db.update(users).set({ role: "staff" }).where(eq(users.id, userId));
  await db.insert(displayBundles).values({ id: "bundle-e2e", sha256: "a".repeat(64), size: 10, r2Key: "e2e/display.zip", schemaVersion: 1, isCurrent: true });
  const device = await registerDevice(db, { name: "検証専用ディスプレイ", orientation: "landscape", resolutionWidth: 1920, resolutionHeight: 1080 }, baseUrl);
  console.log(JSON.stringify({ databaseUrl, baseUrl, staffCreated: true, deviceId: device.deviceId }));
} finally {
  client.close();
}
