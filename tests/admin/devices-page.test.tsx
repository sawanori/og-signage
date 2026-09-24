/**
 * task_019: 端末画面・システム設定の HTML に秘密が出ないこと。
 * ページ（サーバー部品）を実際のサービスと一時 DB で組み立て、描いた HTML と部品に渡すデータを調べる。
 */
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@/db/index";
import { deviceLogs, devices, users } from "@/db/schema";
import { seed } from "@/db/seed";
import { recordHeartbeat, regenerateDeviceToken, registerDevice, type PiConfigFile } from "@/lib/services/devices";
import { createUser } from "@/lib/services/users";
import { openTempDb } from "../helpers/temp-db";

const state = vi.hoisted(() => ({ db: null as unknown as Db, session: null as unknown }));

vi.mock("@/lib/runtime", () => ({ getDb: () => state.db }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {} }),
  redirect: (url: string) => {
    throw new Error(`redirect:${url}`);
  },
}));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return {
    ...actual,
    requireRole: (role: import("@/lib/auth").Role) =>
      actual.requireRole(role, { db: state.db, getSession: async () => state.session }),
  };
});

const { default: DevicesPage } = await import("@/app/admin/devices/page");
const { default: SettingsPage } = await import("@/app/admin/settings/page");

let db: Db;
let close: () => void;

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
  await seed(db);
  const [admin] = await db
    .insert(users)
    .values({ email: "admin@example.com", name: "管理者", role: "administrator" })
    .returning();
  state.session = { userId: admin.id, sessionVersion: admin.sessionVersion };
});

afterEach(() => close());

const input = { name: "エントランス（1F）", orientation: "portrait" as const, resolutionWidth: 1080, resolutionHeight: 1920 };

describe("端末画面", () => {
  it("登録・再発行したトークンもそのハッシュも HTML に出ない", async () => {
    const issued = await registerDevice(db, input, "https://signage.example");
    const reissued = await regenerateDeviceToken(db, issued.deviceId, "https://signage.example");
    const tokens = [issued, reissued].map((c) => (JSON.parse(c.content) as PiConfigFile).deviceToken);
    const [{ tokenHash }] = await db.select({ tokenHash: devices.tokenHash }).from(devices);

    const now = Math.floor(Date.now() / 1000);
    await recordHeartbeat(
      db,
      issued.deviceId,
      {
        agentVersion: "agent-1.2.3",
        bundleId: "bundle-xyz",
        appliedVersion: "c".repeat(64),
        pendingVersion: null,
        mode: "display",
        displayHealthy: true,
        nextVideoAt: null,
        lastVideoFinishedAt: null,
        timeSynced: true,
        diskFreeBytes: 12 * 1024 ** 3,
        cpuTempC: 48.5,
        memAvailableBytes: 1024 ** 3,
      },
      now,
    );
    await db.insert(deviceLogs).values({ deviceId: issued.deviceId, type: "sync", message: "同期しました", createdAt: now });

    const element = await DevicesPage();
    const html = renderToStaticMarkup(element);
    const props = JSON.stringify(element.props);

    // 画面には状態・Heartbeat の値・ログ・プレビューへのリンクが出る
    expect(html).toContain("エントランス（1F）");
    expect(html).toContain("ONLINE");
    expect(html).toContain("agent-1.2.3");
    expect(html).toContain("12.0 GB");
    expect(html).toContain("48.5℃");
    expect(html).toContain("同期しました");
    expect(html).toContain(`/admin/devices/${issued.deviceId}/preview`);

    for (const secret of [...tokens, tokenHash]) {
      expect(html).not.toContain(secret);
      expect(props).not.toContain(secret);
    }
    expect(props).not.toContain("tokenHash");
  });

  it("端末がなければ登録を促す", async () => {
    const html = renderToStaticMarkup(await DevicesPage());
    expect(html).toContain("まだ端末が登録されていません");
  });

  it("Staff はダッシュボードへ送る", async () => {
    const [staff] = await db.insert(users).values({ email: "staff@example.com", role: "staff" }).returning();
    state.session = { userId: staff.id, sessionVersion: staff.sessionVersion };
    await expect(DevicesPage()).rejects.toThrow("redirect:/admin");
    await expect(SettingsPage()).rejects.toThrow("redirect:/admin");
  });
});

describe("システム設定", () => {
  it("ユーザー一覧を出し、パスワードとそのハッシュは HTML に出ない", async () => {
    const password = "initial-password-123";
    await createUser(db, { email: "staff@example.com", name: "受付", role: "staff", password });
    const [{ passwordHash }] = await db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.email, "staff@example.com"));

    const element = await SettingsPage();
    const html = renderToStaticMarkup(element);
    expect(html).toContain("staff@example.com");
    expect(html).toContain("admin@example.com");
    for (const secret of [password, passwordHash!, "passwordHash"]) {
      expect(html).not.toContain(secret);
      expect(JSON.stringify(element.props)).not.toContain(secret);
    }
  });
});
