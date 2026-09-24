/**
 * 定期動画の設定（/admin/videos。Staff 以上。計画 8.2 節、要件定義書 12〜14 節）。
 * 端末ごとの ON/OFF・間隔・再生順と、その端末の再生リスト（並べ替え・追加・外す）。
 * 端末が複数あるときだけ端末を選ぶ欄を出す（?device=<id>。省略時は登録順で最初の端末）。
 */
import { eq } from "drizzle-orm";
import { playlists } from "@/db/schema";
import { DeviceSelect } from "@/components/admin/device-select";
import admin from "@/components/admin/admin.module.css";
import { MediaTabs } from "@/components/admin/media-tabs";
import type { VideosPageData } from "@/components/admin/media-types";
import styles from "@/components/admin/media.module.css";
import { PlaylistEditor } from "@/components/admin/playlist-editor";
import { getDb } from "@/lib/runtime";
import { listDevices } from "@/lib/services/devices";
import { listMedia } from "@/lib/services/media";
import { getDevicePlaybackSettings, getPlaylistItems, PlaybackServiceError } from "@/lib/services/playback";

export const dynamic = "force-dynamic";

export const metadata = { title: "定期動画の設定 | シェアハウス サイネージ管理" };

const thumbnailUrl = (id: string) => `/api/media/${encodeURIComponent(id)}/thumbnail`;

function EmptyCard({ message }: { message: string }) {
  return (
    <section className={`${admin.card} ${styles.emptyCard}`} aria-label="定期動画の設定">
      <div className={admin.empty}>
        <p>{message}</p>
      </div>
    </section>
  );
}

export default async function VideosPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const db = getDb();
  const devices = await listDevices(db);
  const options = devices.map((d) => ({ id: d.id, name: d.name }));

  if (devices.length === 0) {
    return (
      <div className={styles.page}>
        <MediaTabs current="/admin/videos" />
        <EmptyCard message="サイネージ端末が登録されていません。端末を登録すると、動画の設定ができます。" />
      </div>
    );
  }

  const device = devices.find((d) => d.id === params.device) ?? devices[0];
  const tabs = (
    <MediaTabs current="/admin/videos">
      {devices.length > 1 ? <DeviceSelect devices={options} current={device.id} /> : null}
    </MediaTabs>
  );

  let settings;
  try {
    settings = await getDevicePlaybackSettings(db, device.id);
  } catch (e) {
    if (!(e instanceof PlaybackServiceError) || e.code !== "not_found") throw e;
    return (
      <div className={styles.page}>
        {tabs}
        <EmptyCard message="この端末の動画設定が見つかりません。管理者にお問い合わせください。" />
      </div>
    );
  }

  const [playlistRow] = settings.playlistId
    ? await db.select().from(playlists).where(eq(playlists.id, settings.playlistId))
    : [];
  const [items, library] = await Promise.all([
    playlistRow ? getPlaylistItems(db, playlistRow.id) : Promise.resolve([]),
    listMedia(db),
  ]);

  const data: VideosPageData = {
    deviceId: device.id,
    settings: {
      revision: settings.revision,
      enabled: settings.enabled,
      intervalMinutes: settings.intervalMinutes,
      mode: settings.playbackMode,
      volume: settings.volume,
    },
    playlist: playlistRow
      ? {
          id: playlistRow.id,
          revision: playlistRow.revision,
          items: items.map((item) => ({
            itemId: item.id,
            mediaId: item.mediaId,
            name: item.media.name,
            durationSeconds: item.media.durationSeconds,
            thumbnailUrl: item.media.thumbnailR2Key ? thumbnailUrl(item.mediaId) : null,
          })),
        }
      : null,
    library: library
      .filter((row) => row.type === "video")
      .map((row) => ({
        mediaId: row.id,
        name: row.name,
        durationSeconds: row.durationSeconds,
        thumbnailUrl: row.thumbnailR2Key ? thumbnailUrl(row.id) : null,
        playable: row.playable,
      })),
  };

  return (
    <div className={styles.page}>
      {tabs}
      <PlaylistEditor key={device.id} data={data} devices={options} />
    </div>
  );
}
