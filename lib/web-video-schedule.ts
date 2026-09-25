/**
 * Web 公開のサイネージ（/signage）で定期動画を流すときの判定（2026-09-25 ユーザー指示。Pi のブラウザで /signage を開いて使うため）。
 *
 * 規則は Pi の raspberry-pi/agent/player.py（_tick_display・_select_next_item・_consume_test_play_if_new）と
 * computeNextVideoAt（lib/display-rules.ts）に合わせる。画面の部品は app/signage/video-player.tsx。
 */
import type { PlaylistItem, SignageConfig, VideoSettings } from "./config-schema";
import { tokyoDateKey } from "./dates";
import { computeNextVideoAt } from "./display-rules";

/** ブラウザに覚えておく再生の状態（localStorage。端末 id ごと） */
export type VideoMemory = {
  /** 順番再生で次に流す位置 */
  sequenceIndex: number;
  /** 直前に流した動画（ランダムで同じものを続けないため） */
  lastPlayedMediaId: string | null;
  /** 処理済みのテスト表示の要求時刻。undefined はまだ記録していない（初めて開いた） */
  lastTestPlayProcessedAt?: number | null;
  /** 再生に失敗してその日は外す動画（日本時間の日付ごと） */
  excluded: { dateKey: string; mediaIds: string[] };
};

export const EMPTY_VIDEO_MEMORY: VideoMemory = {
  sequenceIndex: 0,
  lastPlayedMediaId: null,
  excluded: { dateKey: "", mediaIds: [] },
};

/**
 * テスト表示の要求を今処理するか。前回処理した値より新しい要求なら 1 回だけ再生する。
 * まだ何も記録していない（初めて開いた）ときは、今の値を処理済みとして記録するだけで再生しない（開くたびに流れないように）。
 */
export function consumeTestPlay(
  requestedAt: number | null,
  lastProcessedAt: number | null | undefined,
): { play: boolean; processedAt: number | null } {
  if (lastProcessedAt === undefined) return { play: false, processedAt: requestedAt };
  if (requestedAt === null || (lastProcessedAt !== null && requestedAt <= lastProcessedAt)) {
    return { play: false, processedAt: lastProcessedAt };
  }
  return { play: true, processedAt: requestedAt };
}

/** 今日（日本時間）外している動画。日付が変わっていれば空 */
export function excludedToday(memory: VideoMemory, now: number): Set<string> {
  return new Set(memory.excluded.dateKey === tokyoDateKey(now) ? memory.excluded.mediaIds : []);
}

/** 再生に失敗した動画を今日は外す */
export function excludeForToday(memory: VideoMemory, mediaId: string, now: number): VideoMemory {
  const ids = excludedToday(memory, now);
  ids.add(mediaId);
  return { ...memory, excluded: { dateKey: tokyoDateKey(now), mediaIds: [...ids] } };
}

/**
 * 次に流す 1 本。順番（sequence）は保存した位置から、ランダム（random）は直前と同じものを避けて選ぶ。
 * 今日外している動画は飛ばす。流せるものが無ければ null。返す memory は、この 1 本を流したあとの状態。
 */
export function selectNextVideo(
  playlist: readonly PlaylistItem[],
  mode: VideoSettings["mode"],
  memory: VideoMemory,
  now: number,
  random: () => number = Math.random,
): { item: PlaylistItem; memory: VideoMemory } | null {
  const excluded = excludedToday(memory, now);
  const candidates = playlist.filter((p) => !excluded.has(p.mediaId));
  if (candidates.length === 0) return null;

  if (mode === "random") {
    const pool = candidates.filter((p) => p.mediaId !== memory.lastPlayedMediaId);
    const from = pool.length > 0 ? pool : candidates;
    const item = from[Math.floor(random() * from.length) % from.length];
    return { item, memory: { ...memory, lastPlayedMediaId: item.mediaId } };
  }

  const n = playlist.length;
  for (let offset = 0; offset < n; offset++) {
    const index = (memory.sequenceIndex + offset) % n;
    const item = playlist[index];
    if (excluded.has(item.mediaId)) continue;
    return { item, memory: { ...memory, sequenceIndex: (index + 1) % n, lastPlayedMediaId: item.mediaId } };
  }
  return null;
}

type Commands = SignageConfig["commands"];

/** テスト表示の要求のうち新しいほう（30 秒ごとの config の値と、数秒ごとに確かめている値） */
export function newerCommands(fromConfig: Commands, polled: Commands | null): Commands {
  if (!polled) return fromConfig;
  return (polled.testPlayRequestedAt ?? -1) > (fromConfig.testPlayRequestedAt ?? -1) ? polled : fromConfig;
}

/**
 * テスト表示で流す 1 本。管理画面で動画を選んで押したとき（mediaId がプレイリストにある）はその動画で、
 * 順番の位置は進めない。そうでなければ次の 1 本（順番の位置も進める。Pi と同じ）
 */
export function pickTestVideo(
  playlist: readonly PlaylistItem[],
  mediaId: string | null | undefined,
  mode: VideoSettings["mode"],
  memory: VideoMemory,
  now: number,
): { item: PlaylistItem; memory: VideoMemory } | null {
  const chosen = mediaId ? playlist.find((p) => p.mediaId === mediaId) : undefined;
  if (chosen) return { item: chosen, memory: { ...memory, lastPlayedMediaId: chosen.mediaId } };
  return selectNextVideo(playlist, mode, memory, now);
}

export type VideoDueInput = {
  video: VideoSettings;
  playlistLength: number;
  /** 表示時間帯の中か（isWithinDisplaySchedule） */
  visible: boolean;
  now: number;
  /** テスト表示の要求を今処理したか（consumeTestPlay の play） */
  testPlay: boolean;
  /** ページを開いた時刻 */
  startedAt: number;
  lastVideoFinishedAt: number | null;
  /** ページを開いたあとで表示時間帯が始まった時刻 */
  displayWindowStartedAt: number | null;
};

/** 今、動画を始めるか。定期再生が有効で動画があり、表示時間帯の中のときだけ。テスト表示なら間隔を待たない */
export function isVideoDue(input: VideoDueInput): boolean {
  if (!input.video.enabled || input.playlistLength === 0 || !input.visible) return false;
  if (input.testPlay) return true;
  return (
    input.now >=
    computeNextVideoAt({
      intervalMinutes: input.video.intervalMinutes,
      lastVideoFinishedAt: input.lastVideoFinishedAt,
      startedAt: input.startedAt,
      displayWindowStartedAt: input.displayWindowStartedAt,
    })
  );
}

/** 保存しておいた状態を読む。形が違う・読めないときは初期状態（テスト表示は未記録） */
export function parseVideoMemory(raw: string | null): VideoMemory {
  if (!raw) return EMPTY_VIDEO_MEMORY;
  try {
    const v = JSON.parse(raw) as Partial<VideoMemory>;
    return {
      sequenceIndex: Number.isInteger(v.sequenceIndex) && (v.sequenceIndex as number) >= 0 ? (v.sequenceIndex as number) : 0,
      lastPlayedMediaId: typeof v.lastPlayedMediaId === "string" ? v.lastPlayedMediaId : null,
      ...("lastTestPlayProcessedAt" in v
        ? { lastTestPlayProcessedAt: typeof v.lastTestPlayProcessedAt === "number" ? v.lastTestPlayProcessedAt : null }
        : {}),
      excluded:
        v.excluded && typeof v.excluded.dateKey === "string" && Array.isArray(v.excluded.mediaIds)
          ? { dateKey: v.excluded.dateKey, mediaIds: v.excluded.mediaIds.filter((id) => typeof id === "string") }
          : EMPTY_VIDEO_MEMORY.excluded,
    };
  } catch {
    return EMPTY_VIDEO_MEMORY;
  }
}
