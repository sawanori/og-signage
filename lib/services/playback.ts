/**
 * 動画設定とプレイリストのサービス（実装計画 8.1 節・10 節、要件定義書 12〜14 節）。
 *
 * - プレイリストの追加・削除・並べ替えは `playlists.revision` による条件付き更新。不一致は
 *   PlaybackServiceError（409 conflict）。position は毎回 0..n-1 で振り直すので重複しない。
 * - 端末ごとの再生設定（ON/OFF・間隔・順番/ランダム）は `video_playback_settings.revision` による
 *   条件付き更新。音量は devices.volume にあるので、同じ更新で一緒に保存する。
 * - playable=false・state=deleting・type≠video の媒体はプレイリストに追加できない。
 * - テスト表示の要求は devices.test_play_requested_at に現在時刻を入れるだけ（1 回限りの消費は
 *   Pi 側・config-builder 側の責務）。
 * - content_version のような版の加算は行わない。config の版は config JSON の SHA-256 で決まる。
 * - 権限（Staff 以上）は呼び出し側（app/admin/_actions/playback.ts）で確認する。
 */
import { and, asc, eq } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../../db/index";
import { devices, media, nowSeconds, playlistItems, playlists, videoPlaybackSettings } from "../../db/schema";
import { VIDEO_INTERVAL_MINUTES } from "../config-schema";

export type PlaylistRow = typeof playlists.$inferSelect;
export type PlaylistItemRow = typeof playlistItems.$inferSelect;
export type MediaRow = typeof media.$inferSelect;
export type PlaylistItemWithMedia = PlaylistItemRow & { media: MediaRow };
export type VideoPlaybackSettingsRow = typeof videoPlaybackSettings.$inferSelect;
export type DevicePlaybackSettings = VideoPlaybackSettingsRow & { volume: number };

export type PlaylistMutationResult = { playlist: PlaylistRow; items: PlaylistItemWithMedia[] };

export type PlaybackErrorCode = "invalid_input" | "invalid_media" | "not_found" | "conflict";

const STATUS_BY_CODE: Record<PlaybackErrorCode, 400 | 404 | 409> = {
  invalid_input: 400,
  invalid_media: 400,
  not_found: 404,
  conflict: 409,
};

export class PlaybackServiceError extends Error {
  readonly status: 400 | 404 | 409;
  constructor(
    readonly code: PlaybackErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PlaybackServiceError";
    this.status = STATUS_BY_CODE[code];
  }
}

const playlistNotFound = () => new PlaybackServiceError("not_found", "プレイリストが見つかりません");
const deviceNotFound = () => new PlaybackServiceError("not_found", "端末が見つかりません");
const conflict = () => new PlaybackServiceError("conflict", "他の人が先に更新しました");

/** Zod の失敗を最初の項目のメッセージで 400 にする */
function invalidInput(error: z.ZodError): PlaybackServiceError {
  return new PlaybackServiceError("invalid_input", error.issues[0]?.message ?? "入力内容を確認してください");
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw invalidInput(result.error);
  return result.data;
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Queryable = Db | Tx;

// ---------------------------------------------------------------- プレイリスト

async function loadPlaylist(tx: Queryable, playlistId: string): Promise<PlaylistRow> {
  const [row] = await tx.select().from(playlists).where(eq(playlists.id, playlistId));
  if (!row) throw playlistNotFound();
  return row;
}

async function loadItemsWithMedia(tx: Queryable, playlistId: string): Promise<PlaylistItemWithMedia[]> {
  const rows = await tx
    .select({ item: playlistItems, media })
    .from(playlistItems)
    .innerJoin(media, eq(playlistItems.mediaId, media.id))
    .where(eq(playlistItems.playlistId, playlistId))
    .orderBy(asc(playlistItems.position));
  return rows.map((row) => ({ ...row.item, media: row.media }));
}

/** playable=false・state=deleting・type≠video は追加不可（理由は利用者向けの日本語） */
async function assertMediaEligible(tx: Queryable, mediaId: string): Promise<void> {
  const [row] = await tx
    .select({ type: media.type, playable: media.playable, state: media.state })
    .from(media)
    .where(eq(media.id, mediaId));
  if (!row) throw new PlaybackServiceError("invalid_media", "選んだ動画が見つかりません。削除された可能性があります");
  if (row.state === "deleting") {
    throw new PlaybackServiceError("invalid_media", "この動画は削除予定のため追加できません");
  }
  if (row.type !== "video" || !row.playable) {
    throw new PlaybackServiceError("invalid_media", "この動画はサイネージで再生できない形式です");
  }
}

export async function getPlaylistItems(db: Db, playlistId: string): Promise<PlaylistItemWithMedia[]> {
  await loadPlaylist(db, playlistId);
  return loadItemsWithMedia(db, playlistId);
}

const addPlaylistItemSchema = z.object({
  revision: z.int().nonnegative(),
  mediaId: z.string().min(1, "動画を選んでください"),
});

/** 末尾に追加する。position は既存件数（0 から詰まっている前提。削除・並べ替えでその形を保つ） */
export async function addPlaylistItem(db: Db, playlistId: string, input: unknown): Promise<PlaylistMutationResult> {
  const { revision, mediaId } = parse(addPlaylistItemSchema, input);
  return db.transaction(async (tx) => {
    const playlist = await loadPlaylist(tx, playlistId);
    if (playlist.revision !== revision) throw conflict();
    await assertMediaEligible(tx, mediaId);

    const current = await tx
      .select({ id: playlistItems.id })
      .from(playlistItems)
      .where(eq(playlistItems.playlistId, playlistId));
    await tx.insert(playlistItems).values({ playlistId, mediaId, position: current.length });

    const [updated] = await tx
      .update(playlists)
      .set({ revision: revision + 1, updatedAt: nowSeconds() })
      .where(and(eq(playlists.id, playlistId), eq(playlists.revision, revision)))
      .returning();
    if (!updated) throw conflict();
    return { playlist: updated, items: await loadItemsWithMedia(tx, playlistId) };
  });
}

const removePlaylistItemSchema = z.object({
  revision: z.int().nonnegative(),
  itemId: z.string().min(1, "削除する項目を指定してください"),
});

/** 削除後に position を 0..n-1 へ詰め直す */
export async function removePlaylistItem(db: Db, playlistId: string, input: unknown): Promise<PlaylistMutationResult> {
  const { revision, itemId } = parse(removePlaylistItemSchema, input);
  return db.transaction(async (tx) => {
    const playlist = await loadPlaylist(tx, playlistId);
    if (playlist.revision !== revision) throw conflict();

    const deleted = await tx
      .delete(playlistItems)
      .where(and(eq(playlistItems.id, itemId), eq(playlistItems.playlistId, playlistId)))
      .returning({ id: playlistItems.id });
    if (deleted.length === 0) {
      throw new PlaybackServiceError("not_found", "指定した動画が見つかりません。削除された可能性があります");
    }

    const remaining = await tx
      .select()
      .from(playlistItems)
      .where(eq(playlistItems.playlistId, playlistId))
      .orderBy(asc(playlistItems.position));
    for (const [index, row] of remaining.entries()) {
      if (row.position !== index) {
        await tx.update(playlistItems).set({ position: index }).where(eq(playlistItems.id, row.id));
      }
    }

    const [updated] = await tx
      .update(playlists)
      .set({ revision: revision + 1, updatedAt: nowSeconds() })
      .where(and(eq(playlists.id, playlistId), eq(playlists.revision, revision)))
      .returning();
    if (!updated) throw conflict();
    return { playlist: updated, items: await loadItemsWithMedia(tx, playlistId) };
  });
}

const reorderPlaylistItemsSchema = z.object({
  revision: z.int().nonnegative(),
  /** 新しい並び順に並べた playlist_items.id の全件 */
  itemIds: z.array(z.string().min(1)).min(1, "並べ替えの対象を指定してください"),
});

/** 渡された順に position（0 始まり）を振り直す。現在の項目と完全に同じ集合でなければ 400 */
export async function reorderPlaylistItems(db: Db, playlistId: string, input: unknown): Promise<PlaylistMutationResult> {
  const { revision, itemIds } = parse(reorderPlaylistItemsSchema, input);
  return db.transaction(async (tx) => {
    const playlist = await loadPlaylist(tx, playlistId);
    if (playlist.revision !== revision) throw conflict();

    const current = await tx
      .select({ id: playlistItems.id })
      .from(playlistItems)
      .where(eq(playlistItems.playlistId, playlistId));
    const currentIds = new Set(current.map((row) => row.id));
    const requestedIds = new Set(itemIds);
    const sameSet =
      itemIds.length === currentIds.size &&
      requestedIds.size === itemIds.length &&
      itemIds.every((id) => currentIds.has(id));
    if (!sameSet) throw new PlaybackServiceError("invalid_input", "並べ替えの対象が正しくありません");

    for (const [index, itemId] of itemIds.entries()) {
      await tx.update(playlistItems).set({ position: index }).where(eq(playlistItems.id, itemId));
    }

    const [updated] = await tx
      .update(playlists)
      .set({ revision: revision + 1, updatedAt: nowSeconds() })
      .where(and(eq(playlists.id, playlistId), eq(playlists.revision, revision)))
      .returning();
    if (!updated) throw conflict();
    return { playlist: updated, items: await loadItemsWithMedia(tx, playlistId) };
  });
}

// ---------------------------------------------------------------- 端末ごとの再生設定

async function loadDeviceAndSettings(
  tx: Queryable,
  deviceId: string,
): Promise<{ device: { id: string; volume: number }; settings: VideoPlaybackSettingsRow }> {
  const [device] = await tx.select({ id: devices.id, volume: devices.volume }).from(devices).where(eq(devices.id, deviceId));
  if (!device) throw deviceNotFound();
  const [settings] = await tx.select().from(videoPlaybackSettings).where(eq(videoPlaybackSettings.deviceId, deviceId));
  if (!settings) throw new PlaybackServiceError("not_found", "この端末の動画設定が見つかりません");
  return { device, settings };
}

export async function getDevicePlaybackSettings(db: Db, deviceId: string): Promise<DevicePlaybackSettings> {
  const { device, settings } = await loadDeviceAndSettings(db, deviceId);
  return { ...settings, volume: device.volume };
}

const devicePlaybackSettingsUpdateSchema = z.object({
  revision: z.int().nonnegative(),
  enabled: z.boolean(),
  intervalMinutes: z.literal([...VIDEO_INTERVAL_MINUTES], "動画の間隔は一覧から選んでください"),
  mode: z.enum(["sequence", "random"], "再生順を選んでください"),
  volume: z.int().min(0, "音量は0〜100で入力してください").max(100, "音量は0〜100で入力してください"),
});

/** ON/OFF・間隔・順番/ランダムは video_playback_settings、音量は devices を同じ操作で更新する */
export async function updateDevicePlaybackSettings(
  db: Db,
  deviceId: string,
  input: unknown,
): Promise<DevicePlaybackSettings> {
  const data = parse(devicePlaybackSettingsUpdateSchema, input);
  return db.transaction(async (tx) => {
    const { settings } = await loadDeviceAndSettings(tx, deviceId);
    if (settings.revision !== data.revision) throw conflict();

    const [updated] = await tx
      .update(videoPlaybackSettings)
      .set({
        enabled: data.enabled,
        intervalMinutes: data.intervalMinutes,
        playbackMode: data.mode,
        revision: data.revision + 1,
        updatedAt: nowSeconds(),
      })
      .where(and(eq(videoPlaybackSettings.deviceId, deviceId), eq(videoPlaybackSettings.revision, data.revision)))
      .returning();
    if (!updated) throw conflict();

    await tx.update(devices).set({ volume: data.volume, updatedAt: nowSeconds() }).where(eq(devices.id, deviceId));
    return { ...updated, volume: data.volume };
  });
}

// ---------------------------------------------------------------- テスト表示

/** 対象端末が次の同期で次の動画を1本すぐ再生する（1回限り）。消費は Pi・config-builder 側の責務 */
export async function requestTestPlay(db: Db, deviceId: string): Promise<{ testPlayRequestedAt: number }> {
  const now = nowSeconds();
  const [updated] = await db
    .update(devices)
    .set({ testPlayRequestedAt: now, updatedAt: now })
    .where(eq(devices.id, deviceId))
    .returning({ testPlayRequestedAt: devices.testPlayRequestedAt });
  if (!updated) throw deviceNotFound();
  return { testPlayRequestedAt: updated.testPlayRequestedAt! };
}
