import { createClient } from "@libsql/client";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/libsql/migrator";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  memberSpotlightSubmissions,
  memberSpotlights,
  notices,
  playlistItems,
  playlists,
  users,
} from "../../db/schema";
import { SEED_HOUSE_SETTINGS_ID, SEED_PLAYLIST_ID, seed } from "../../db/seed";
import { verifyPassword } from "../../lib/password";
import { spotlightSubmissionInputSchema } from "../../lib/spotlight-submissions";
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
  "member_spotlight_submissions",
  "member_spotlights",
  "notices",
  "playlist_item_slides",
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

describe("メンバー紹介の申請テーブル", () => {
  const { requestKey: _key, consent: _consent, email: _email, ...payload } = spotlightSubmissionInputSchema.parse({
    requestKey: "123e4567-e89b-42d3-a456-426614174000", companyName: "所属", personName: "名前", email: "member@example.com", consent: true,
  });
  void _key;
  void _consent;
  void _email;
  const submission = (requestKey: string) => ({ requestKey, requestFingerprint: "a".repeat(64), payload, consentedAt: 100, consentVersion: 1 });

  it("既存の掲載情報と分離し、受信中・未回収の初期値を持つ", async () => {
    await db.insert(memberSpotlights).values({ id: "published", companyName: "公開済み", personName: "既存" });
    const [row] = await db.insert(memberSpotlightSubmissions).values(submission("request-1")).returning();
    expect(row).toMatchObject({ status: "receiving", revision: 0, payload, photoFile: null, logoFile: null, submittedAt: null, cleanupNextAt: null, cleanupCompletedAt: null, contactEmail: null, notificationStatus: null, notificationAttempts: 0, notificationName: null, notifiedAt: null, notificationNextAt: null });
    expect((await db.select().from(memberSpotlights)).map((r) => r.id)).toEqual(["published"]);
    expect(await db.select().from(media)).toHaveLength(0);
  });

  it("request_keyの重複をDBで拒否する", async () => {
    await db.insert(memberSpotlightSubmissions).values(submission("same"));
    await expectConstraintError(db.insert(memberSpotlightSubmissions).values(submission("same")), /UNIQUE constraint failed/);
  });

  it("5状態以外をDBのCHECKで拒否する", async () => {
    const [row] = await db.insert(memberSpotlightSubmissions).values(submission("status")).returning();
    await expect(client.execute({ sql: "UPDATE member_spotlight_submissions SET status = ? WHERE id = ?", args: ["published", row.id] })).rejects.toThrow(/CHECK constraint failed/);
    for (const status of ["receiving", "pending", "approved", "rejected", "expired"] as const) {
      await db.update(memberSpotlightSubmissions).set({ status }).where(eq(memberSpotlightSubmissions.id, row.id));
    }
  });

  it("審査者と掲載メンバーを削除しても申請の状態は残り参照だけnullになる", async () => {
    await db.insert(users).values({ id: "reviewer", email: "reviewer@example.com" });
    await db.insert(memberSpotlights).values({ id: "approved", companyName: "所属", personName: "名前" });
    const [row] = await db.insert(memberSpotlightSubmissions).values({ ...submission("approved-request"), status: "approved", reviewedBy: "reviewer", approvedSpotlightId: "approved" }).returning();
    await expectConstraintError(db.insert(memberSpotlightSubmissions).values({ ...submission("other"), approvedSpotlightId: "approved" }), /UNIQUE constraint failed/);
    await db.delete(users).where(eq(users.id, "reviewer"));
    await db.delete(memberSpotlights).where(eq(memberSpotlights.id, "approved"));
    const [remaining] = await db.select().from(memberSpotlightSubmissions).where(eq(memberSpotlightSubmissions.id, row.id));
    expect(remaining).toMatchObject({ status: "approved", reviewedBy: null, approvedSpotlightId: null });
  });

  it("期限の来た未回収だけを索引条件と同じ順序で取得できる", async () => {
    await db.insert(memberSpotlightSubmissions).values([
      { ...submission("late"), id: "b", status: "rejected", cleanupNextAt: 200 },
      { ...submission("first"), id: "a", status: "expired", cleanupNextAt: 100 },
      { ...submission("done"), status: "rejected", cleanupNextAt: null, cleanupCompletedAt: 80 },
      { ...submission("future"), status: "expired", cleanupNextAt: 500 },
      { ...submission("pending"), status: "pending" },
    ]);
    const rows = await db.select().from(memberSpotlightSubmissions)
      .where(sql`status IN ('rejected', 'expired') AND cleanup_completed_at IS NULL AND cleanup_next_at <= 200`)
      .orderBy(memberSpotlightSubmissions.cleanupNextAt, memberSpotlightSubmissions.id).limit(50);
    expect(rows.map((row) => row.requestKey)).toEqual(["first", "late"]);
    const indexes = await client.execute("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'member_spotlight_submissions_cleanup_idx'");
    expect(indexes.rows[0].sql).toMatch(/cleanup_next_at.*id.*WHERE.*rejected.*expired.*cleanup_completed_at.*IS NULL/i);
  });

  it("追加migrationは既存の掲載済みデータを変更しない", async () => {
    const previousMigrations = join(dir, "previous-migrations");
    cpSync("db/migrations", previousMigrations, { recursive: true });
    const journalPath = join(previousMigrations, "meta/_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 9);
    writeFileSync(journalPath, JSON.stringify(journal));
    const previous = createDb(createClient, pathToFileURL(join(dir, "previous.db")).href);
    try {
      await migrate(previous.db, { migrationsFolder: previousMigrations });
      const [before] = await previous.db.insert(memberSpotlights).values({ id: "preserved", companyName: "以前の所属", personName: "以前の名前", personNameKana: "なまえ", tags: ["既存"], enabled: false, revision: 3 }).returning();
      await migrate(previous.db, { migrationsFolder: "db/migrations" });
      expect(await previous.db.select().from(memberSpotlights)).toEqual([before]);
      await previous.db.insert(memberSpotlightSubmissions).values(submission("new"));
      expect(await previous.db.select().from(memberSpotlightSubmissions)).toHaveLength(1);
    } finally {
      previous.client.close();
    }
  });

  it("0011は既存申請の確認待ち・承認済み・却下済みを保ち、通知列だけ初期化する", async () => {
    const previousMigrations = join(dir, "before-email-migrations");
    cpSync("db/migrations", previousMigrations, { recursive: true });
    const journalPath = join(previousMigrations, "meta/_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8"));
    journal.entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 10);
    writeFileSync(journalPath, JSON.stringify(journal));
    const previous = createDb(createClient, pathToFileURL(join(dir, "before-email.db")).href);
    try {
      await migrate(previous.db, { migrationsFolder: previousMigrations });
      for (const status of ["pending", "approved", "rejected"]) {
        await previous.client.execute({
          sql: "INSERT INTO member_spotlight_submissions (id, request_key, request_fingerprint, status, payload, consented_at, consent_version, created_at, updated_at) VALUES (?, ?, 'hash', ?, ?, 100, 1, 100, 100)",
          args: [status, status, status, JSON.stringify(payload)],
        });
      }
      const before = await previous.client.execute("SELECT * FROM member_spotlight_submissions ORDER BY id");
      await migrate(previous.db, { migrationsFolder: "db/migrations" });
      const after = await previous.client.execute("SELECT * FROM member_spotlight_submissions ORDER BY id");
      expect(after.rows).toEqual(before.rows.map((row) => ({ ...row, contact_email: null, notification_status: null, notification_attempts: 0, notified_at: null, notification_next_at: null, notification_name: null })));
    } finally {
      previous.client.close();
    }
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

  it("member_spotlights.photo_media_id と logo_media_id（メンバー紹介の写真とロゴ）", async () => {
    await insertMedia("photo");
    await insertMedia("logo");
    await db.insert(memberSpotlights).values({ companyName: "株式会社サンプル", personName: "山田 陸", photoMediaId: "photo", logoMediaId: "logo" });
    await expectConstraintError(deleteMedia("photo"), FK);
    await expectConstraintError(deleteMedia("logo"), FK);
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
