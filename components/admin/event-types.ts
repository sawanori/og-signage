/** イベント管理画面（/admin/events）の部品が受け取るデータ */

export type EventCategoryOption = { id: string; name: string; color: string };

/** 管理画面の状態の区分。開催前（今日・開始間近を含む）/ 開催中 / 終了 */
export type EventPhase = "before" | "ongoing" | "ended";

export type ManagedEvent = {
  id: string;
  title: string;
  emoji: string | null;
  status: "published" | "draft";
  startAt: number;
  endAt: number | null;
  location: string | null;
  hostName: string | null;
  description: string | null;
  capacity: number | null;
  participantCount: number | null;
  category: EventCategoryOption | null;
  imageUrl: string | null;
  phase: EventPhase;
};

/** 保存・削除のあと一覧に戻ったときの知らせ（URL の ?saved=） */
export type SavedNotice = "created" | "updated" | "deleted";

export const SAVED_MESSAGES: Record<SavedNotice, string> = {
  created: "イベントを追加しました",
  updated: "イベントを保存しました",
  deleted: "イベントを削除しました",
};

/** 管理用素材 API の縮小画像 */
export const mediaThumbnailUrl = (mediaId: string) => `/api/media/${encodeURIComponent(mediaId)}/thumbnail`;
