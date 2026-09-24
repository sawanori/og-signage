/**
 * 端末画面（/admin/devices）のデータ。部品に渡す形は components/admin/devices-types.ts。
 * トークンのハッシュは読まない（listDevices が除いた値から、画面に出す項目だけを選ぶ）。
 */
import type { Db } from "@/db/index";
import { listDeviceMediaFailures, listDevices, listRecentDeviceLogs } from "@/lib/services/devices";
import { getDevicePlaybackSettings, PlaybackServiceError } from "@/lib/services/playback";
import type { DeviceView } from "@/components/admin/devices-types";

async function loadPlayback(db: Db, deviceId: string): Promise<DeviceView["playback"]> {
  try {
    const s = await getDevicePlaybackSettings(db, deviceId);
    return { revision: s.revision, enabled: s.enabled, intervalMinutes: s.intervalMinutes, mode: s.playbackMode, volume: s.volume };
  } catch (e) {
    if (e instanceof PlaybackServiceError) return null;
    throw e;
  }
}

export async function loadDevices(db: Db, now: number): Promise<DeviceView[]> {
  const devices = await listDevices(db, now);
  return Promise.all(
    devices.map(async (d) => {
      const [logs, failures, playback] = await Promise.all([
        listRecentDeviceLogs(db, d.id),
        listDeviceMediaFailures(db, d.id),
        loadPlayback(db, d.id),
      ]);
      return {
        id: d.id,
        name: d.name,
        status: d.status,
        lastSeenAt: d.lastSeenAt,
        orientation: d.orientation,
        resolutionWidth: d.resolutionWidth,
        resolutionHeight: d.resolutionHeight,
        agentVersion: d.agentVersion,
        bundleId: d.bundleId,
        appliedVersion: d.appliedVersion,
        diskFreeBytes: d.diskFreeBytes,
        cpuTempC: d.cpuTempC,
        timeSynced: d.timeSynced,
        logs,
        failures,
        playback,
      };
    }),
  );
}
