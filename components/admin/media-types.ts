/**
 * 動画・メディア画面（/admin/media、/admin/videos）が受け取るデータ。
 * ページ（サーバー）がサービス（lib/services/*）から組み立て、部品はこの形だけを見て描く。
 */

/** 再生条件（要件定義書 15 節）を外れた動画に出す文言 */
export const UNPLAYABLE_MESSAGE =
  "この動画はサイネージで再生できない形式です（MP4・H.264・1080p 以下・30fps 以下に変換してください）";

export type MediaFailureView = {
  deviceName: string;
  reason: "download_failed" | "hash_mismatch" | "playback_failed";
  quarantined: boolean;
  count: number;
  lastAt: number;
};

export type MediaListItem = {
  id: string;
  name: string;
  type: "image" | "video";
  fileSize: number | null;
  durationSeconds: number | null;
  width: number | null;
  height: number | null;
  playable: boolean;
  thumbnailUrl: string | null;
  createdAt: number;
  failures: MediaFailureView[];
};

export type VideoLibraryItem = {
  mediaId: string;
  name: string;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
  playable: boolean;
};

export type PlaylistEntry = {
  itemId: string;
  mediaId: string;
  name: string;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
};

export type VideoSettingsValues = {
  revision: number;
  enabled: boolean;
  intervalMinutes: number;
  mode: "sequence" | "random";
  volume: number;
};

export type VideosPageData = {
  deviceId: string;
  settings: VideoSettingsValues;
  /** 端末に再生リストが紐づいていなければ null */
  playlist: { id: string; revision: number; items: PlaylistEntry[] } | null;
  library: VideoLibraryItem[];
};

export type DeviceOption = { id: string; name: string };
