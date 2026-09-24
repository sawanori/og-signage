/**
 * 動画・メディア（/admin/media。Staff 以上。計画 8.2 節、要件定義書 26 節）。
 * 画像と動画の一覧・アップロード・削除。端末が報告した取得・再生の失敗も一覧に出す。
 * ログイン確認は app/admin/layout.tsx が行う（役割は Staff 以上しかない）。
 */
import { MediaLibrary } from "@/components/admin/media-library";
import { MediaTabs } from "@/components/admin/media-tabs";
import type { MediaFailureView, MediaListItem } from "@/components/admin/media-types";
import styles from "@/components/admin/media.module.css";
import { UploadDropzone } from "@/components/admin/upload-dropzone";
import { getDb } from "@/lib/runtime";
import { listMedia, listMediaFailures } from "@/lib/services/media";
import { ADMIN_TITLE } from "@/components/admin/brand";

export const dynamic = "force-dynamic";

export const metadata = { title: `動画・メディア | ${ADMIN_TITLE}` };

const mediaUrl = (id: string, part: "thumbnail" | "file") => `/api/media/${encodeURIComponent(id)}/${part}`;

export default async function MediaPage() {
  const db = getDb();
  const [rows, failures] = await Promise.all([listMedia(db), listMediaFailures(db)]);

  const failuresByMedia = new Map<string, MediaFailureView[]>();
  for (const f of failures) {
    const list = failuresByMedia.get(f.mediaId) ?? [];
    list.push({ deviceName: f.deviceName, reason: f.reason, quarantined: f.quarantined, count: f.count, lastAt: f.lastAt });
    failuresByMedia.set(f.mediaId, list);
  }

  const items: MediaListItem[] = rows.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    fileSize: row.fileSize,
    durationSeconds: row.durationSeconds,
    width: row.width,
    height: row.height,
    playable: row.playable,
    // 画像はサムネイルを作らない（長辺 1920px 以下の WebP）ので本体を縮小表示する
    thumbnailUrl: row.thumbnailR2Key ? mediaUrl(row.id, "thumbnail") : row.type === "image" ? mediaUrl(row.id, "file") : null,
    createdAt: row.createdAt,
    failures: failuresByMedia.get(row.id) ?? [],
  }));

  return (
    <div className={styles.page}>
      <MediaTabs current="/admin/media" />
      <UploadDropzone />
      <MediaLibrary items={items} />
    </div>
  );
}
