import { createClient } from "@libsql/client";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb, type Db } from "../../db/index";
import {
  devices,
  eventCategories,
  events,
  houseRules,
  houseSettings,
  media,
  mediaFailures,
  notices,
  playlistItems,
  playlists,
  users,
} from "../../db/schema";
import { SEED_HOUSE_SETTINGS_ID, SEED_PLAYLIST_ID, seed } from "../../db/seed";
import { verifyPassword } from "../../lib/password";
import { createAdmin } from "../../scripts/create-admin";

const TABLES = [
  "device_logs",
  "devices",
  "display_bundles",
  "display_schedules",
  "event_categories",
  "events",
  "house_rules",
  "house_settings",
  "media",
  "media_failures",
  "notices",
  "playlist_items",
  "playlists",
  "uploads",
  "users",
  "video_playback_settings",
  "weather_cache",
];

let dir: string;
let client: ReturnType<typeof createClient>;
let db: Db;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "og-app-db-"));
  ({ client, db } = createDb(createClient, pathToFileURL(join(dir, "test.db")).href));
  await migrate(db, { migrationsFolder: "db/migrations" });
});

afterEach(() => {
  client.close();
  rmSync(dir, { recursive: true, force: true });
});

async function insertMedia(id: string, type: "image" | "video" = "image") {
  await db.insert(media).values({ id, name: id, type, r2Key: `media/${id}` });
}

async function deleteMedia(id: string) {
  await db.delete(media).where(eq(media.id, id));
}

/** drizzle はドライバーのエラーを cause に入れて投げ直す */
async function expectConstraintError(promise: Promise<unknown>, pattern: RegExp) {
  const error = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(Error);
  expect(String((error as Error).cause)).toMatch(pattern);
}

const FK = /FOREIGN KEY constraint failed/;

describe("マイグレーション", () => {
  it("全テーブルができ、外部キーが有効", async () => {
    const result = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '__drizzle%' ORDER BY name",
    );
    expect(result.rows.map((r) => r.name)).toEqual(TABLES);

    const fk = await client.execute("PRAGMA foreign_keys");
    expect(fk.rows[0].foreign_keys).toBe(1);
  });
});

describe("参照中の media は削除できない", () => {
  it("events.image_media_id", async () => {
    await insertMedia("m1");
    await db.insert(events).values({ id: "e1", title: "Pizza Night", startAt: 1, imageMediaId: "m1" });
    await expectConstraintError(deleteMedia("m1"), FK);

    await db.delete(events).where(eq(events.id, "e1"));
    await deleteMedia("m1");
    expect(await db.select().from(media)).toHaveLength(0);
  });

  it("notices.image_media_id", async () => {
    await insertMedia("m1");
    await db.insert(notices).values({ id: "n1", title: "清掃", imageMediaId: "m1" });
    await expectConstraintError(deleteMedia("m1"), FK);
  });

  it("house_settings.logo_media_id と footer_image_media_id", async () => {
    await insertMedia("logo");
    await insertMedia("footer");
    await db.insert(houseSettings).values({ id: "h", houseName: "H", logoMediaId: "logo", footerImageMediaId: "footer" });
    await expectConstraintError(deleteMedia("logo"), FK);
    await expectConstraintError(deleteMedia("footer"), FK);
  });

  it("playlist_items.media_id", async () => {
    await insertMedia("v1", "video");
    await db.insert(playlists).values({ id: "p1", name: "定期動画" });
    await db.insert(playlistItems).values({ playlistId: "p1", mediaId: "v1", position: 0 });
    await expectConstraintError(deleteMedia("v1"), FK);
  });
});

describe("media_failures", () => {
  it("media_id と bundle_id のどちらか一方だけを許す", async () => {
    await insertMedia("m1");
    await db.insert(devices).values({ id: "d1", name: "エントランス", tokenHash: "h" });
    await db.insert(mediaFailures).values({ deviceId: "d1", mediaId: "m1", reason: "hash_mismatch", lastAt: 1 });
    await expectConstraintError(
      db.insert(mediaFailures).values({ deviceId: "d1", reason: "hash_mismatch", lastAt: 1 }),
      /CHECK constraint failed/,
    );
  });
});

describe("初期データ", () => {
  it("2 回実行しても同じ", async () => {
    await seed(db);
    await seed(db);
    expect(await db.select().from(eventCategories)).toHaveLength(5);
    expect(await db.select().from(houseRules)).toHaveLength(3);
    const house = await db.select().from(houseSettings);
    expect(house.map((h) => [h.id, h.houseName])).toEqual([[SEED_HOUSE_SETTINGS_ID, "HARMONY HOUSE"]]);
    const lists = await db.select().from(playlists);
    expect(lists.map((p) => p.id)).toEqual([SEED_PLAYLIST_ID]);
    const schedules = await client.execute("SELECT count(*) AS n FROM display_schedules");
    expect(schedules.rows[0].n).toBe(0);
  });
});

describe("create-admin", () => {
  it("Administrator を作り、パスワードが照合できる", async () => {
    const id = await createAdmin(db, { email: "Admin@Example.com", name: "管理者", password: "correct horse battery" });
    const [user] = await db.select().from(users).where(eq(users.id, id));
    expect(user.email).toBe("admin@example.com");
    expect(user.role).toBe("administrator");
    expect(user.isActive).toBe(true);
    expect(user.passwordHash).toMatch(/^pbkdf2\$100000\$/);
    expect(await verifyPassword("correct horse battery", user.passwordHash!)).toBe(true);
    expect(await verifyPassword("wrong password!!", user.passwordHash!)).toBe(false);
  });
});
