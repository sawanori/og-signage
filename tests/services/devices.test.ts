/**
 * task_011: 端末の登録・トークン・状態。DB は一時 libSQL ファイル。
 * Server Action は getDb・セッション・要求ヘッダーだけを差し替えて、権限の確認を実際に通す。
 */
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../../db/index";
import { deviceLogs, devices, users, videoPlaybackSettings } from "../../db/schema";
import { seed, SEED_PLAYLIST_ID } from "../../db/seed";
import { authenticateDevice, DeviceAuthError, hashDeviceToken, parseBearerToken } from "../../lib/device-auth";
import {
  deleteDevice,
  deviceStatus,
  listDevices,
  ONLINE_WINDOW_SECONDS,
  PI_DATA_DIR,
  recordHeartbeat,
  regenerateDeviceToken,
  registerDevice,
  type PiConfigFile,
} from "../../lib/services/devices";
import type { HeartbeatInput } from "../../lib/validators";
import { openTempDb } from "../helpers/temp-db";

const ORIGIN = "https://signage.example";

const state = vi.hoisted(() => ({ db: null as unknown as Db, session: null as unknown }));

vi.mock("../../lib/runtime", () => ({ getDb: () => state.db }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ origin: "https://signage.example" }) }));
vi.mock("../../lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/auth")>();
  return {
    ...actual,
    requireRole: (role: import("../../lib/auth").Role) =>
      actual.requireRole(role, { db: state.db, getSession: async () => state.session }),
  };
});

const { deleteDeviceAction, regenerateDeviceTokenAction, registerDeviceAction } = await import(
  "../../app/admin/_actions/devices"
);

let db: Db;
let close: () => void;

beforeEach(async () => {
  ({ db, close } = await openTempDb());
  state.db = db;
  state.session = null;
});

afterEach(() => close());

const input = { name: "1F ラウンジ", orientation: "portrait" as const, resolutionWidth: 1080, resolutionHeight: 1920 };

function bearer(token: string): Request {
  return new Request(`${ORIGIN}/api/device/config`, { headers: { authorization: `Bearer ${token}` } });
}

function parse(content: string): PiConfigFile {
  return JSON.parse(content) as PiConfigFile;
}

async function loginAs(role: "staff" | "administrator") {
  const [user] = await db
    .insert(users)
    .values({ email: `${role}@example.com`, role })
    .returning({ id: users.id, sessionVersion: users.sessionVersion });
  state.session = { userId: user.id, sessionVersion: user.sessionVersion };
}

function form(values: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(values)) data.set(k, v);
  return data;
}

const heartbeat: HeartbeatInput = {
  agentVersion: "1.0.0",
  bundleId: "bundle-1",
  appliedVersion: "a".repeat(64),
  pendingVersion: null,
  mode: "display",
  displayHealthy: true,
  nextVideoAt: 1_800_000_600,
  lastVideoFinishedAt: null,
  timeSynced: true,
  diskFreeBytes: 10_000_000_000,
  cpuTempC: 48.5,
  memAvailableBytes: 1_000_000_000,
};

describe("登録と設定ファイル", () => {
  it("Pi の config.py が読む形式で返し、動画設定を既定値で作る", async () => {
    await seed(db);
    const issued = await registerDevice(db, input, `${ORIGIN}/`);
    const file = parse(issued.content);

    expect(issued.fileName).toBe("config.json");
    expect(file).toEqual({
      apiBaseUrl: ORIGIN,
      deviceToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      dataDir: PI_DATA_DIR,
      deviceId: issued.deviceId,
      deviceName: "1F ラウンジ",
      orientation: "portrait",
      resolutionWidth: 1080,
      resolutionHeight: 1920,
    });

    const [settings] = await db
      .select()
      .from(videoPlaybackSettings)
      .where(eq(videoPlaybackSettings.deviceId, issued.deviceId));
    expect(settings).toMatchObject({
      playlistId: SEED_PLAYLIST_ID,
      enabled: true,
      intervalMinutes: 10,
      playbackMode: "sequence",
    });
    const [device] = await db.select().from(devices).where(eq(devices.id, issued.deviceId));
    expect(device.volume).toBe(0);
  });

  it("トークンの平文は DB に残らず、SHA-256 だけが保存される", async () => {
    const issued = await registerDevice(db, input, ORIGIN);
    const token = parse(issued.content).deviceToken;

    const [device] = await db.select().from(devices).where(eq(devices.id, issued.deviceId));
    expect(device.tokenHash).toBe(await hashDeviceToken(token));
    expect(device.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    // どの列にも平文が入っていない
    expect(JSON.stringify(device)).not.toContain(token);
    // 一覧にも token_hash を出さない
    const [summary] = await listDevices(db);
    expect(summary).not.toHaveProperty("tokenHash");
  });

  it("入力が不正なら登録しない", async () => {
    await expect(registerDevice(db, { ...input, name: " " }, ORIGIN)).rejects.toThrow();
    expect(await db.select().from(devices)).toHaveLength(0);
  });
});

describe("端末の認証", () => {
  it("正しいトークンで端末を返し、違うトークン・形式違いは 401", async () => {
    const issued = await registerDevice(db, input, ORIGIN);
    const token = parse(issued.content).deviceToken;

    expect((await authenticateDevice(db, bearer(token))).id).toBe(issued.deviceId);
    await expect(authenticateDevice(db, bearer("A".repeat(43)))).rejects.toBeInstanceOf(DeviceAuthError);
    await expect(authenticateDevice(db, new Request(ORIGIN))).rejects.toMatchObject({ status: 401 });
    expect(parseBearerToken(`Basic ${token}`)).toBeNull();
    expect(parseBearerToken(`Bearer ${token}x`)).toBeNull();
    expect(parseBearerToken(`bearer ${token}`)).toBe(token);
  });

  it("例外メッセージにトークンを含めない", async () => {
    const token = "B".repeat(43);
    const error = await authenticateDevice(db, bearer(token)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DeviceAuthError);
    expect(String((error as Error).message)).not.toContain(token);
    expect(String((error as Error).stack)).not.toContain(token);
  });

  it("再発行後は旧トークンが 401、新トークンが通る", async () => {
    const issued = await registerDevice(db, input, ORIGIN);
    const oldToken = parse(issued.content).deviceToken;

    const reissued = await regenerateDeviceToken(db, issued.deviceId, ORIGIN);
    const newToken = parse(reissued.content).deviceToken;

    expect(newToken).not.toBe(oldToken);
    await expect(authenticateDevice(db, bearer(oldToken))).rejects.toMatchObject({ status: 401 });
    expect((await authenticateDevice(db, bearer(newToken))).id).toBe(issued.deviceId);
  });

  it("削除した端末のトークンは 401。ログと動画設定も消える", async () => {
    const issued = await registerDevice(db, input, ORIGIN);
    const token = parse(issued.content).deviceToken;
    await db.insert(deviceLogs).values({ deviceId: issued.deviceId, type: "info", message: "x" });

    await deleteDevice(db, issued.deviceId);

    await expect(authenticateDevice(db, bearer(token))).rejects.toMatchObject({ status: 401 });
    expect(await db.select().from(videoPlaybackSettings)).toHaveLength(0);
    expect(await db.select().from(deviceLogs)).toHaveLength(0);
  });
});

describe("状態判定", () => {
  const now = 1_800_000_000;

  it("last_seen_at が 5 分以内なら ONLINE、超えたら OFFLINE", () => {
    expect(deviceStatus({ lastSeenAt: now - ONLINE_WINDOW_SECONDS, displayHealthy: true }, now)).toBe("online");
    expect(deviceStatus({ lastSeenAt: now - ONLINE_WINDOW_SECONDS - 1, displayHealthy: true }, now)).toBe("offline");
    expect(deviceStatus({ lastSeenAt: null, displayHealthy: null }, now)).toBe("offline");
  });

  it("ONLINE で displayHealthy=false なら表示異常。OFFLINE なら OFFLINE のまま", () => {
    expect(deviceStatus({ lastSeenAt: now - ONLINE_WINDOW_SECONDS, displayHealthy: false }, now)).toBe(
      "display_error",
    );
    expect(deviceStatus({ lastSeenAt: now - ONLINE_WINDOW_SECONDS - 1, displayHealthy: false }, now)).toBe("offline");
  });

  it("Heartbeat の最新値を保存し、一覧の状態に反映する", async () => {
    const issued = await registerDevice(db, input, ORIGIN);
    expect((await listDevices(db, now))[0].status).toBe("offline");

    await recordHeartbeat(db, issued.deviceId, heartbeat, now);
    const [online] = await listDevices(db, now + ONLINE_WINDOW_SECONDS);
    expect(online).toMatchObject({ status: "online", lastSeenAt: now, agentVersion: "1.0.0", cpuTempC: 48.5 });

    await recordHeartbeat(db, issued.deviceId, { ...heartbeat, displayHealthy: false }, now);
    expect((await listDevices(db, now))[0].status).toBe("display_error");
    expect((await listDevices(db, now + ONLINE_WINDOW_SECONDS + 1))[0].status).toBe("offline");
  });
});

describe("Server Actions の権限", () => {
  const values = { name: "玄関", orientation: "landscape", resolutionWidth: "1920", resolutionHeight: "1080" };

  it("Staff は登録・再発行・削除ができない", async () => {
    const issued = await registerDevice(db, input, ORIGIN);
    const before = await db.select().from(devices);
    await loginAs("staff");

    const denied = { ok: false, error: "この操作を行う権限がありません" };
    expect(await registerDeviceAction(form(values))).toEqual(denied);
    expect(await regenerateDeviceTokenAction(issued.deviceId)).toEqual(denied);
    expect(await deleteDeviceAction(issued.deviceId)).toEqual(denied);
    expect(await db.select().from(devices)).toEqual(before);
  });

  it("未ログインは拒否する", async () => {
    expect(await registerDeviceAction(form(values))).toEqual({ ok: false, error: "ログインしてください" });
    expect(await db.select().from(devices)).toHaveLength(0);
  });

  it("Administrator は登録・再発行・削除ができ、設定ファイルを受け取る", async () => {
    await loginAs("administrator");

    const registered = await registerDeviceAction(form(values));
    if (!registered.ok) throw new Error(registered.error);
    const file = parse(registered.data.content);
    expect(file).toMatchObject({ apiBaseUrl: ORIGIN, orientation: "landscape", resolutionWidth: 1920 });

    const reissued = await regenerateDeviceTokenAction(registered.data.deviceId);
    if (!reissued.ok) throw new Error(reissued.error);
    expect(parse(reissued.data.content).deviceToken).not.toBe(file.deviceToken);

    expect(await deleteDeviceAction(registered.data.deviceId)).toEqual({ ok: true, data: null });
    expect(await deleteDeviceAction(registered.data.deviceId)).toMatchObject({ ok: false });
  });
});
