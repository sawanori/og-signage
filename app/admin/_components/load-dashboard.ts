/**
 * 管理画面の枠とダッシュボードのデータを、既存のサービス（lib/services/*）から組み立てる。
 * 部品に渡す形は components/admin/dashboard-types.ts（/dev/dashboard の固定データと同じ形）。
 */
import type { Db } from "@/db/index";
import type { AuthUser } from "@/lib/auth";
import { listDevices, type DeviceSummary } from "@/lib/services/devices";
import { listEvents } from "@/lib/services/events";
import { getDesignSettings } from "@/lib/services/house";
import { listNotices } from "@/lib/services/notices";
import { getDevicePlaybackSettings, getPlaylistItems } from "@/lib/services/playback";
import type {
  DashboardData,
  DashboardEvent,
  DashboardVideoSettings,
  ShellData,
} from "@/components/admin/dashboard-types";

const mediaThumbnailUrl = (mediaId: string) => `/api/media/${encodeURIComponent(mediaId)}/thumbnail`;

function displayName(user: AuthUser): string {
  return user.name?.trim() || user.email.split("@")[0];
}

export async function loadShell(db: Db, user: AuthUser, now: number): Promise<ShellData> {
  const [{ settings }, devices] = await Promise.all([getDesignSettings(db), listDevices(db, now)]);
  return {
    houseName: settings.houseName,
    user: { name: displayName(user), role: user.role, avatarUrl: null },
    alerts: devices
      .filter((d) => d.status !== "online")
      .map((d) => ({
        id: d.id,
        message:
          d.status === "offline"
            ? `端末「${d.name}」と通信できていません`
            : `端末「${d.name}」の表示に異常があります`,
      })),
    sidebarImageUrl: null,
  };
}

async function loadVideo(db: Db, device: DeviceSummary): Promise<DashboardVideoSettings> {
  const settings = await getDevicePlaybackSettings(db, device.id);
  const items = settings.playlistId ? await getPlaylistItems(db, settings.playlistId) : [];
  return {
    deviceId: device.id,
    revision: settings.revision,
    enabled: settings.enabled,
    intervalMinutes: settings.intervalMinutes,
    mode: settings.playbackMode,
    volume: settings.volume,
    videos: items.map((item) => ({
      mediaId: item.mediaId,
      name: item.media.name,
      durationSeconds: item.media.durationSeconds,
      thumbnailUrl: item.media.thumbnailR2Key ? mediaThumbnailUrl(item.mediaId) : null,
    })),
    nextVideoAt: device.nextVideoAt,
    observedAt: device.lastSeenAt,
  };
}

export async function loadDashboard(db: Db, now: number): Promise<DashboardData> {
  const [{ categories }, rows, devices, notices] = await Promise.all([
    getDesignSettings(db),
    listEvents(db, {}, now),
    listDevices(db, now),
    listNotices(db),
  ]);
  const categoryById = new Map(categories.map((c) => [c.id, { id: c.id, name: c.name, color: c.color }]));

  const events: DashboardEvent[] = rows.map((row) => ({
    id: row.id,
    status: row.status,
    title: row.title,
    description: row.description,
    location: row.location,
    startAt: row.startAt,
    endAt: row.endAt,
    category: row.categoryId ? (categoryById.get(row.categoryId) ?? null) : null,
    emoji: row.emoji,
    hostName: row.hostName,
    catchCopy: row.catchCopy,
    participation: row.participation,
    capacity: row.capacity,
    participantCount: row.participantCount,
    qrUrl: row.qrUrl,
    image: null,
    createdAt: row.createdAt,
    imageUrl: row.imageMediaId ? mediaThumbnailUrl(row.imageMediaId) : null,
  }));

  // MVP は 1 台運用（計画 6 節 19）。ダッシュボードは登録順で最初の端末を出す
  const device = devices[0] ?? null;
  const notice = notices[0] ?? null;

  return {
    now,
    events,
    video: device ? await loadVideo(db, device) : null,
    notice: notice
      ? {
          id: notice.id,
          title: notice.title,
          body: notice.body,
          imageMediaId: notice.imageMediaId,
          enabled: notice.enabled,
          displayMode: notice.displayMode,
          displayStartTime: notice.displayStartTime,
          displayEndTime: notice.displayEndTime,
          revision: notice.revision,
        }
      : null,
    device: device ? { id: device.id, name: device.name, status: device.status, lastSeenAt: device.lastSeenAt } : null,
  };
}
