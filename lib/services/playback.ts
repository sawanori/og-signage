/**
 * 動画設定とプレイリストのサービス（実装計画 8.1 節・10 節、要件定義書 12〜14 節）。
 *
 * - プレイリストの追加・削除・並べ替えは `playlists.revision` による条件付き更新。不一致は
 *   PlaybackServiceError（409 conflict）。position は毎回 0..n-1 で振り直すので重複しない。
 * - 端末ごとの再生設定（ON/OFF・間隔・順番/ランダム）は `video_playback_settings.revision` による
 *   条件付き更新。音量は devices.volume にあるので、同じ更新で一緒に保存する。
 * - playable=false・state=deleting・type≠video の媒体はプレイリストに追加できない。
 * - テスト表示の要求は devices.test_play_requested_at に現在時刻を入れるだけ（1 回限りの消費は
 *   Pi 側・表示側の責務）。動画を選んで押したときは devices.test_play_media_id にその動画も入れる
 *   （その端末の再生リストにある動画だけ。Web 版はその動画を流す。2026-09-25 ユーザー指示）。
 * - content_version のような版の加算は行わない。config の版は config JSON の SHA-256 で決まる。
 * - 画面の「保存する」は saveDevicePlayback でプレイリストと再生設定を 1 トランザクションで丸ごと保存する。
 * - 再生リストには動画のほか、写真のスライドショー（1〜3 枚・写真ごとの秒数・合計 30 秒まで）を 1 つ入れられる
 *   （2026-09-27 ユーザー指示）。playlist_items.kind = slideshow で、media_id は 1 枚目の写真。写真は playlist_item_slides。
 *   動画の本数の上限（MAX_VIDEOS）はスライドショーを数えない。
 * - 権限（Staff 以上）は呼び出し側（app/admin/_actions/playback.ts）で確認する。
 */
import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../../db/index";
import {
  devices,
  media,
  nowSeconds,
  playlistItemSlides,
  playlistItems,
  playlists,
  videoPlaybackSettings,
} from "../../db/schema";
import { MAX_SLIDES, MAX_SLIDESHOW_SECONDS, VIDEO_INTERVAL_MINUTES } from "../config-schema";
import { MAX_VIDEO_SECONDS, MAX_VIDEOS, isVideoTooLong } from "../file-sniff";

export type PlaylistRow = typeof playlists.$inferSelect;
export type PlaylistItemRow = typeof playlistItems.$inferSelect;
export type MediaRow = typeof media.$inferSelect;
/** スライドショーの 1 枚（並び順・表示する秒数・写真） */
export type PlaylistSlideWithMedia = { mediaId: string; durationSeconds: number; position: number; media: MediaRow };
/** 再生リストの 1 項目。動画は media が動画、スライドショーは media が 1 枚目の写真で slides に全部の写真 */
export type PlaylistItemWithMedia = PlaylistItemRow & { media: MediaRow; slides: PlaylistSlideWithMedia[] };
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
  const slideshowIds = rows.filter((row) => row.item.kind === "slideshow").map((row) => row.item.id);
  const slides =
    slideshowIds.length > 0
      ? await tx
          .select({ slide: playlistItemSlides, media })
          .from(playlistItemSlides)
          .innerJoin(media, eq(playlistItemSlides.mediaId, media.id))
          .where(inArray(playlistItemSlides.playlistItemId, slideshowIds))
          .orderBy(asc(playlistItemSlides.position))
      : [];
  return rows.map((row) => ({
    ...row.item,
    media: row.media,
    slides: slides
      .filter((s) => s.slide.playlistItemId === row.item.id)
      .map((s) => ({ mediaId: s.slide.mediaId, durationSeconds: s.slide.durationSeconds, position: s.slide.position, media: s.media })),
  }));
}

/** スライドショーの写真は、active な画像だけ（理由は利用者向けの日本語） */
async function assertSlideEligible(tx: Queryable, mediaId: string): Promise<void> {
  const [row] = await tx.select({ type: media.type, state: media.state }).from(media).where(eq(media.id, mediaId));
  if (!row) throw new PlaybackServiceError("invalid_media", "選んだ写真が見つかりません。削除された可能性があります");
  if (row.state === "deleting") throw new PlaybackServiceError("invalid_media", "この写真は削除予定のため使えません");
  if (row.type !== "image") throw new PlaybackServiceError("invalid_media", "スライドショーには写真（画像）を選んでください");
}

/** playable=false・state=deleting・type≠video は追加不可（理由は利用者向けの日本語） */
async function assertMediaEligible(tx: Queryable, mediaId: string): Promise<void> {
  const [row] = await tx
    .select({ type: media.type, playable: media.playable, state: media.state, durationSeconds: media.durationSeconds })
    .from(media)
    .where(eq(media.id, mediaId));
  if (!row) throw new PlaybackServiceError("invalid_media", "選んだ動画が見つかりません。削除された可能性があります");
  if (row.state === "deleting") {
    throw new PlaybackServiceError("invalid_media", "この動画は削除予定のため追加できません");
  }
  if (row.type !== "video" || !row.playable) {
    throw new PlaybackServiceError("invalid_media", "この動画はサイネージで再生できない形式です");
  }
  if (isVideoTooLong(row.durationSeconds)) {
    throw new PlaybackServiceError("invalid_media", `この動画は ${MAX_VIDEO_SECONDS} 秒を超えているため再生リストに入れられません`);
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
      .select({ id: playlistItems.id, kind: playlistItems.kind })
      .from(playlistItems)
      .where(eq(playlistItems.playlistId, playlistId));
    if (current.filter((row) => row.kind === "video").length >= MAX_VIDEOS) {
      throw new PlaybackServiceError("invalid_input", `再生する動画は ${MAX_VIDEOS} 本までです`);
    }
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

    // スライドショーの写真の行も先に消す（外部キーの連動削除に頼らない）
    const [target] = await tx
      .select({ id: playlistItems.id })
      .from(playlistItems)
      .where(and(eq(playlistItems.id, itemId), eq(playlistItems.playlistId, playlistId)));
    if (target) await tx.delete(playlistItemSlides).where(eq(playlistItemSlides.playlistItemId, target.id));
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

// ---------------------------------------------------------------- まとめて保存

const slideInputSchema = z.object({
  mediaId: z.string().min(1, "写真を選んでください"),
  durationSeconds: z
    .int("写真の秒数を選んでください")
    .min(1, "写真の秒数を選んでください")
    .max(MAX_SLIDESHOW_SECONDS, `スライドショーは合計 ${MAX_SLIDESHOW_SECONDS} 秒までです`),
});

const playlistItemInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("video"), mediaId: z.string().min(1, "動画を選んでください") }),
  z.object({
    kind: z.literal("slideshow"),
    slides: z
      .array(slideInputSchema)
      .min(1, "スライドショーの写真を 1 枚以上選んでください")
      .max(MAX_SLIDES, `スライドショーの写真は ${MAX_SLIDES} 枚までです`),
  }),
]);

type PlaylistItemInput = z.infer<typeof playlistItemInputSchema>;

const savePlaybackSchema = z.object({
  settings: devicePlaybackSettingsUpdateSchema,
  /**
   * 端末にプレイリストが無いときは null。items は新しい並び順の全件（空配列で全部外す）。
   * スライドショー以前の画面は動画の mediaIds だけを送るので、動画の並びとして受ける
   */
  playlist: z
    .object({
      revision: z.int().nonnegative(),
      items: z.array(playlistItemInputSchema).optional(),
      mediaIds: z.array(z.string().min(1, "動画を選んでください")).optional(),
    })
    .transform(({ revision, items, mediaIds }) => ({
      revision,
      items: items ?? (mediaIds ?? []).map((mediaId): PlaylistItemInput => ({ kind: "video", mediaId })),
    }))
    .superRefine(({ items }, ctx) => {
      if (items.filter((item) => item.kind === "video").length > MAX_VIDEOS) {
        ctx.addIssue({ code: "custom", message: `再生する動画は ${MAX_VIDEOS} 本までです` });
      }
      const slideshows = items.filter((item) => item.kind === "slideshow");
      if (slideshows.length > 1) ctx.addIssue({ code: "custom", message: "スライドショーは再生リストに 1 つまでです" });
      for (const slideshow of slideshows) {
        if (slideshow.slides.reduce((sum, slide) => sum + slide.durationSeconds, 0) > MAX_SLIDESHOW_SECONDS) {
          ctx.addIssue({ code: "custom", message: `スライドショーは合計 ${MAX_SLIDESHOW_SECONDS} 秒までです` });
        }
      }
    })
    .nullable(),
});

export type SavePlaybackResult = { settings: DevicePlaybackSettings; playlist: PlaylistMutationResult | null };

/**
 * 端末のプレイリストの中身（動画とスライドショーの順序付き配列）と再生設定を 1 トランザクションで丸ごと保存する。
 * プレイリストは video_playback_settings.playlist_id のもの。両方の revision が一致しなければ 409 で、
 * 途中で不正な動画が見つかれば 400 で、どちらも何も書かない。検証規則は addPlaylistItem・
 * updateDevicePlaybackSettings と同じ（新しく加える動画だけ再生可否を確かめる）。
 */
export async function saveDevicePlayback(db: Db, deviceId: string, input: unknown): Promise<SavePlaybackResult> {
  const data = parse(savePlaybackSchema, input);
  return db.transaction(async (tx) => {
    const { settings } = await loadDeviceAndSettings(tx, deviceId);
    if (settings.revision !== data.settings.revision) throw conflict();
    if ((data.playlist === null) !== (settings.playlistId === null)) {
      throw new PlaybackServiceError("invalid_input", "この端末の再生リストが変わりました。最新の内容を読み込んでください");
    }

    let playlistResult: PlaylistMutationResult | null = null;
    if (data.playlist && settings.playlistId) {
      const playlistId = settings.playlistId;
      const playlist = await loadPlaylist(tx, playlistId);
      if (playlist.revision !== data.playlist.revision) throw conflict();

      const current = await tx
        .select({ id: playlistItems.id, mediaId: playlistItems.mediaId, kind: playlistItems.kind })
        .from(playlistItems)
        .where(eq(playlistItems.playlistId, playlistId));
      const existingVideos = new Set(current.filter((row) => row.kind === "video").map((row) => row.mediaId));
      for (const item of data.playlist.items) {
        if (item.kind === "video") {
          if (!existingVideos.has(item.mediaId)) await assertMediaEligible(tx, item.mediaId);
        } else {
          for (const slide of item.slides) await assertSlideEligible(tx, slide.mediaId);
        }
      }

      // 写真の行は外部キーの連動削除に頼らず先に消す（接続の設定によらず、使っていない写真の参照を残さない）
      if (current.length > 0) {
        await tx.delete(playlistItemSlides).where(inArray(playlistItemSlides.playlistItemId, current.map((row) => row.id)));
      }
      await tx.delete(playlistItems).where(eq(playlistItems.playlistId, playlistId));
      for (const [position, item] of data.playlist.items.entries()) {
        const mediaId = item.kind === "video" ? item.mediaId : item.slides[0].mediaId;
        const [row] = await tx
          .insert(playlistItems)
          .values({ playlistId, mediaId, kind: item.kind, position })
          .returning({ id: playlistItems.id });
        if (item.kind === "slideshow") {
          await tx.insert(playlistItemSlides).values(
            item.slides.map((slide, index) => ({
              playlistItemId: row.id,
              mediaId: slide.mediaId,
              durationSeconds: slide.durationSeconds,
              position: index,
            })),
          );
        }
      }
      const [updated] = await tx
        .update(playlists)
        .set({ revision: data.playlist.revision + 1, updatedAt: nowSeconds() })
        .where(and(eq(playlists.id, playlistId), eq(playlists.revision, data.playlist.revision)))
        .returning();
      if (!updated) throw conflict();
      playlistResult = { playlist: updated, items: await loadItemsWithMedia(tx, playlistId) };
    }

    const s = data.settings;
    const [updatedSettings] = await tx
      .update(videoPlaybackSettings)
      .set({
        enabled: s.enabled,
        intervalMinutes: s.intervalMinutes,
        playbackMode: s.mode,
        revision: s.revision + 1,
        updatedAt: nowSeconds(),
      })
      .where(and(eq(videoPlaybackSettings.deviceId, deviceId), eq(videoPlaybackSettings.revision, s.revision)))
      .returning();
    if (!updatedSettings) throw conflict();
    await tx.update(devices).set({ volume: s.volume, updatedAt: nowSeconds() }).where(eq(devices.id, deviceId));

    return { settings: { ...updatedSettings, volume: s.volume }, playlist: playlistResult };
  });
}

// ---------------------------------------------------------------- テスト表示

/**
 * 対象端末がすぐ動画を 1 本再生する（1 回限り）。mediaId を渡せばその動画、無ければ再生リストの次の 1 本。
 * mediaId はその端末の再生リストにある動画だけ（サイネージが読める動画は再生リストのものだけのため）。消費は表示側の責務
 */
export async function requestTestPlay(
  db: Db,
  deviceId: string,
  mediaId: string | null = null,
): Promise<{ testPlayRequestedAt: number; testPlayMediaId: string | null }> {
  if (mediaId !== null) {
    const { settings } = await loadDeviceAndSettings(db, deviceId);
    const [inList] = settings.playlistId
      ? await db
          .select({ id: playlistItems.id })
          .from(playlistItems)
          .where(and(eq(playlistItems.playlistId, settings.playlistId), eq(playlistItems.mediaId, mediaId)))
      : [];
    if (!inList) {
      throw new PlaybackServiceError("invalid_media", "この動画は再生リストにありません。再生リストに入れて保存してからお試しください");
    }
  }
  const now = nowSeconds();
  const [updated] = await db
    .update(devices)
    .set({ testPlayRequestedAt: now, testPlayMediaId: mediaId, updatedAt: now })
    .where(eq(devices.id, deviceId))
    .returning({ testPlayRequestedAt: devices.testPlayRequestedAt, testPlayMediaId: devices.testPlayMediaId });
  if (!updated) throw deviceNotFound();
  return { testPlayRequestedAt: updated.testPlayRequestedAt!, testPlayMediaId: updated.testPlayMediaId };
}
