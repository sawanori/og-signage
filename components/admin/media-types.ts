/**
 * 動画・メディア画面（/admin/media、/admin/videos）が受け取るデータ。
 * ページ（サーバー）がサービス（lib/services/*）から組み立て、部品はこの形だけを見て描く。
 */

/** 再生条件（要件定義書 15 節）を外れた動画に出す文言 */
export const UNPLAYABLE_MESSAGE =
  "この動画はサイネージで再生できない形式です（MP4・H.264 または H.265・1080p 以下・30fps 以下に変換してください）";

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

/** 再生リストの動画 1 本 */
export type PlaylistVideoEntry = {
  kind: "video";
  itemId: string;
  mediaId: string;
  name: string;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
};

/** スライドショーの写真 1 枚（並び順どおり）と、表示する秒数 */
export type PlaylistSlide = { mediaId: string; durationSeconds: number; thumbnailUrl: string };

/**
 * 再生リストのスライドショー（2026-09-27 ユーザー指示。再生リストに 1 つまで・写真 1〜3 枚・合計 30 秒まで）。
 * 項目の mediaId は 1 枚目の写真と同じなので、テスト表示には slides[0].mediaId を渡す
 */
export type PlaylistSlideshowEntry = { kind: "slideshow"; itemId: string; slides: PlaylistSlide[] };

/** 再生リストの 1 項目（動画かスライドショー） */
export type PlaylistEntry = PlaylistVideoEntry | PlaylistSlideshowEntry;

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
