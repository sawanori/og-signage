/**
 * 端末の登録・トークン・状態（task_011。計画 6 節の前提 5・12、8.2 節、9 節）。
 *
 * - トークンは 32 バイト乱数。DB には SHA-256 だけを保存し、平文は登録時と再発行時の戻り値で 1 回だけ返す。
 * - 再発行は token_hash を置き換えるので、旧トークンは即座に無効になる。
 * - 権限（Administrator のみ）は呼び出し側（app/admin/_actions/devices.ts）で確認する。
 */
import { asc, desc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../../db/index";
import { deviceLogs, devices, media, mediaFailures, nowSeconds, playlists, videoPlaybackSettings } from "../../db/schema";
import { hashDeviceToken } from "../device-auth";
import type { HeartbeatInput } from "../validators";

/** last_seen_at からこの秒数以内なら ONLINE */
export const ONLINE_WINDOW_SECONDS = 5 * 60;

/** Pi 上のデータディレクトリ（計画 7 節の Pi の配置） */
export const PI_DATA_DIR = "/var/lib/sharehouse-signage";

export const deviceInputSchema = z.object({
  name: z.string().trim().min(1, "端末名を入力してください").max(100, "端末名は100文字以内で入力してください"),
  orientation: z.enum(["portrait", "landscape"], "向きを選んでください"),
  resolutionWidth: z.coerce.number().int().min(320).max(7680),
  resolutionHeight: z.coerce.number().int().min(320).max(7680),
});

export type DeviceInput = z.infer<typeof deviceInputSchema>;

export type DeviceStatus = "online" | "offline" | "display_error";

export const DEVICE_STATUS_LABELS: Record<DeviceStatus, string> = {
  online: "ONLINE",
  offline: "OFFLINE",
  display_error: "表示異常",
};

/** ONLINE でも最新の Heartbeat が displayHealthy=false なら表示異常 */
export function deviceStatus(
  device: { lastSeenAt: number | null; displayHealthy: boolean | null },
  now: number = nowSeconds(),
): DeviceStatus {
  if (device.lastSeenAt === null || now - device.lastSeenAt > ONLINE_WINDOW_SECONDS) return "offline";
  return device.displayHealthy === false ? "display_error" : "online";
}

/** 32 バイト乱数の base64url（パディングなし、43 文字） */
export function generateDeviceToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Pi 用設定ファイル（raspberry-pi/agent/config.py の load_config が読む JSON） */
export type PiConfigFile = {
  apiBaseUrl: string;
  deviceToken: string;
  dataDir: string;
  deviceId: string;
  deviceName: string;
  orientation: "portrait" | "landscape";
  resolutionWidth: number;
  resolutionHeight: number;
};

export type IssuedConfig = {
  deviceId: string;
  fileName: string;
  /** 設定ファイルの中身。トークンの平文を含むので、保存・ログ出力しない */
  content: string;
};

type DeviceRow = typeof devices.$inferSelect;

function buildPiConfig(device: DeviceRow, token: string, apiBaseUrl: string): IssuedConfig {
  const file: PiConfigFile = {
    apiBaseUrl: apiBaseUrl.replace(/\/+$/, ""),
    deviceToken: token,
    dataDir: PI_DATA_DIR,
    deviceId: device.id,
    deviceName: device.name,
    orientation: device.orientation,
    resolutionWidth: device.resolutionWidth,
    resolutionHeight: device.resolutionHeight,
  };
  return { deviceId: device.id, fileName: "config.json", content: `${JSON.stringify(file, null, 2)}\n` };
}

export class DeviceNotFoundError extends Error {
  constructor() {
    super("device not found");
    this.name = "DeviceNotFoundError";
  }
}

/** 端末を登録し、動画設定を既定値で作る。戻り値の設定ファイルだけがトークンの平文を持つ */
export async function registerDevice(db: Db, input: DeviceInput, apiBaseUrl: string): Promise<IssuedConfig> {
  const values = deviceInputSchema.parse(input);
  const token = generateDeviceToken();
  const id = crypto.randomUUID();
  // MVP のプレイリストは seed の 1 件。あれば既定で紐づける
  const [playlist] = await db.select({ id: playlists.id }).from(playlists).orderBy(asc(playlists.createdAt)).limit(1);

  const [[device]] = await db.batch([
    db
      .insert(devices)
      .values({ id, ...values, tokenHash: await hashDeviceToken(token) })
      .returning(),
    db.insert(videoPlaybackSettings).values({ deviceId: id, playlistId: playlist?.id ?? null }),
  ]);
  return buildPiConfig(device, token, apiBaseUrl);
}

/** トークンを作り直す。旧トークンは即座に無効 */
export async function regenerateDeviceToken(db: Db, deviceId: string, apiBaseUrl: string): Promise<IssuedConfig> {
  const token = generateDeviceToken();
  const [device] = await db
    .update(devices)
    .set({ tokenHash: await hashDeviceToken(token), updatedAt: nowSeconds() })
    .where(eq(devices.id, deviceId))
    .returning();
  if (!device) throw new DeviceNotFoundError();
  return buildPiConfig(device, token, apiBaseUrl);
}

/** 端末を削除する。ログ・失敗報告は外部キーの cascade で消える。動画設定は先に消す */
export async function deleteDevice(db: Db, deviceId: string): Promise<void> {
  const [, deleted] = await db.batch([
    db.delete(videoPlaybackSettings).where(eq(videoPlaybackSettings.deviceId, deviceId)),
    db.delete(devices).where(eq(devices.id, deviceId)).returning({ id: devices.id }),
  ]);
  if (deleted.length === 0) throw new DeviceNotFoundError();
}

export type DeviceSummary = Omit<DeviceRow, "tokenHash"> & { status: DeviceStatus };

/** 一覧（登録順）。token_hash は返さない */
export async function listDevices(db: Db, now: number = nowSeconds()): Promise<DeviceSummary[]> {
  const rows = await db.select().from(devices).orderBy(asc(devices.createdAt), asc(devices.name));
  return rows.map((row) => {
    const { tokenHash: _omit, ...rest } = row;
    void _omit;
    return { ...rest, status: deviceStatus(row, now) };
  });
}

/** Heartbeat の最新値を保存し、last_seen_at を進める（task_012 の POST /api/device/heartbeat が呼ぶ） */
export async function recordHeartbeat(
  db: Db,
  deviceId: string,
  heartbeat: HeartbeatInput,
  now: number = nowSeconds(),
): Promise<void> {
  await db
    .update(devices)
    .set({
      agentVersion: heartbeat.agentVersion,
      bundleId: heartbeat.bundleId,
      appliedVersion: heartbeat.appliedVersion,
      pendingVersion: heartbeat.pendingVersion,
      mode: heartbeat.mode,
      displayHealthy: heartbeat.displayHealthy,
      nextVideoAt: heartbeat.nextVideoAt,
      lastVideoFinishedAt: heartbeat.lastVideoFinishedAt,
      timeSynced: heartbeat.timeSynced,
      diskFreeBytes: heartbeat.diskFreeBytes,
      cpuTempC: heartbeat.cpuTempC,
      memAvailableBytes: heartbeat.memAvailableBytes,
      lastSeenAt: now,
      updatedAt: now,
    })
    .where(eq(devices.id, deviceId));
}

// ---------------------------------------------------------------- 端末画面の読み取り（task_019）

/** 端末画面に出す直近ログの件数 */
export const RECENT_DEVICE_LOG_LIMIT = 10;

export type DeviceLogEntry = { id: string; type: string; message: string | null; createdAt: number };

/** 直近のログ（新しい順） */
export async function listRecentDeviceLogs(
  db: Db,
  deviceId: string,
  limit: number = RECENT_DEVICE_LOG_LIMIT,
): Promise<DeviceLogEntry[]> {
  return db
    .select({ id: deviceLogs.id, type: deviceLogs.type, message: deviceLogs.message, createdAt: deviceLogs.createdAt })
    .from(deviceLogs)
    .where(eq(deviceLogs.deviceId, deviceId))
    .orderBy(desc(deviceLogs.createdAt), desc(deviceLogs.id))
    .limit(limit);
}

export type DeviceMediaFailure = {
  id: string;
  mediaId: string | null;
  /** media が対象のときはその名前。表示バンドルが対象のときは null */
  mediaName: string | null;
  bundleId: string | null;
  reason: "download_failed" | "hash_mismatch" | "playback_failed";
  quarantined: boolean;
  count: number;
  lastAt: number;
};

/** Pi が報告した取得・再生の失敗（最後に起きた順） */
export async function listDeviceMediaFailures(db: Db, deviceId: string): Promise<DeviceMediaFailure[]> {
  return db
    .select({
      id: mediaFailures.id,
      mediaId: mediaFailures.mediaId,
      mediaName: media.name,
      bundleId: mediaFailures.bundleId,
      reason: mediaFailures.reason,
      quarantined: mediaFailures.quarantined,
      count: mediaFailures.count,
      lastAt: mediaFailures.lastAt,
    })
    .from(mediaFailures)
    .leftJoin(media, eq(mediaFailures.mediaId, media.id))
    .where(eq(mediaFailures.deviceId, deviceId))
    .orderBy(desc(mediaFailures.lastAt));
}
