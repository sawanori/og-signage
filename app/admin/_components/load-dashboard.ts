/**
 * 管理画面の枠とダッシュボードのデータを、既存のサービス（lib/services/*）から組み立てる。
 * 部品に渡す形は components/admin/dashboard-types.ts（/dev/dashboard の固定データと同じ形）。
 */
import type { Db } from "@/db/index";
import { env } from "cloudflare:workers";
import { canViewCompanyResearch } from "@/lib/company-research-viewer";
import type { AuthUser } from "@/lib/auth";
import { listDevices, type DeviceSummary } from "@/lib/services/devices";
import { listEvents } from "@/lib/services/events";
import { getDesignSettings } from "@/lib/services/house";
import { listNotices } from "@/lib/services/notices";
import { getDevicePlaybackSettings, getPlaylistItems, type PlaylistItemWithMedia } from "@/lib/services/playback";
import { countPendingSpotlightSubmissions } from "@/lib/services/spotlight-submissions";
import { SPOTLIGHT_SUBMISSIONS_PENDING_PATH } from "@/lib/spotlight-submissions";
import type {
  DashboardData,
  DashboardEvent,
  DashboardVideo,
  DashboardVideoSettings,
  ShellData,
} from "@/components/admin/dashboard-types";

const mediaThumbnailUrl = (mediaId: string) => `/api/media/${encodeURIComponent(mediaId)}/thumbnail`;

function displayName(user: AuthUser): string {
  return user.name?.trim() || user.email.split("@")[0];
}

export async function loadShell(db: Db, user: AuthUser, now: number): Promise<ShellData> {
  const [devices, pendingSubmissions] = await Promise.all([listDevices(db, now), countPendingSpotlightSubmissions(db, user)]);
  return {
    user: { name: displayName(user), role: user.role, avatarUrl: null, canViewCompanyResearch: canViewCompanyResearch(user.email, env.COMPANY_RESEARCH_VIEWER_EMAILS) },
    alerts: [
      // メンバー本人からの登録申請（2026-10-01）。スタッフが確認するまでサイネージに出ない
      ...(pendingSubmissions > 0
        ? [{ id: "spotlight-submissions", message: `メンバー紹介の確認待ちが ${pendingSubmissions} 件あります`, href: SPOTLIGHT_SUBMISSIONS_PENDING_PATH }]
        : []),
      ...devices
        .filter((d) => d.status !== "online")
        .map((d) => ({
          id: d.id,
          message:
            d.status === "offline"
              ? `端末「${d.name}」と通信できていません`
              : `端末「${d.name}」の表示に異常があります`,
        })),
    ],
  };
}

/**
 * 再生リストの項目を、ダッシュボードの定期動画カードの形にする。
 * スライドショー（2026-09-27）は 1 つの項目として、1 枚目の写真のサムネイルと写真の秒数の合計で出す。
 * mediaId は 1 枚目の写真（再生リストの項目の media_id と同じ）なので、押すとサイネージでスライドショーを試せる
 */
export function toDashboardVideos(items: readonly PlaylistItemWithMedia[]): DashboardVideo[] {
  return items.map((item) =>
    item.kind === "slideshow"
      ? {
          mediaId: item.mediaId,
          name: "スライドショー",
          durationSeconds: item.slides.reduce((sum, slide) => sum + slide.durationSeconds, 0),
          // 写真はサムネイルが無くても本体を返す（worker/index.ts）ので、いつも URL を出せる
          thumbnailUrl: mediaThumbnailUrl(item.mediaId),
        }
      : {
          mediaId: item.mediaId,
          name: item.media.name,
          durationSeconds: item.media.durationSeconds,
          thumbnailUrl: item.media.thumbnailR2Key ? mediaThumbnailUrl(item.mediaId) : null,
        },
  );
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
    videos: toDashboardVideos(items),
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
