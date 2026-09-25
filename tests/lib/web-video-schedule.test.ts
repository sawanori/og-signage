/**
 * Web 公開のサイネージで定期動画を流すときの判定（lib/web-video-schedule.ts）。
 * 規則は Pi の raspberry-pi/agent/player.py と同じ。
 */
import { describe, expect, it } from "vitest";
import type { PlaylistItem, VideoSettings } from "@/lib/config-schema";
import { tokyoDateTime } from "@/lib/dates";
import {
  EMPTY_VIDEO_MEMORY,
  consumeTestPlay,
  excludeForToday,
  isVideoDue,
  parseVideoMemory,
  selectNextVideo,
} from "@/lib/web-video-schedule";

const NOW = tokyoDateTime(2026, 9, 25, 10, 0);
const item = (mediaId: string): PlaylistItem => ({
  mediaId,
  sha256: "a".repeat(64),
  size: 1000,
  durationSeconds: 15,
});
const PLAYLIST = [item("v1"), item("v2"), item("v3")];
const video = (overrides: Partial<VideoSettings> = {}): VideoSettings => ({
  enabled: true,
  intervalMinutes: 10,
  mode: "sequence",
  ...overrides,
});

describe("consumeTestPlay", () => {
  it("初めて開いたときは今の要求を処理済みにするだけで流さない", () => {
    expect(consumeTestPlay(NOW - 60, undefined)).toEqual({ play: false, processedAt: NOW - 60 });
    expect(consumeTestPlay(null, undefined)).toEqual({ play: false, processedAt: null });
  });

  it("前回より新しい要求なら 1 回だけ流す", () => {
    expect(consumeTestPlay(NOW, NOW - 60)).toEqual({ play: true, processedAt: NOW });
    expect(consumeTestPlay(NOW, NOW)).toEqual({ play: false, processedAt: NOW });
    expect(consumeTestPlay(NOW, null)).toEqual({ play: true, processedAt: NOW });
    expect(consumeTestPlay(null, NOW)).toEqual({ play: false, processedAt: NOW });
  });
});

describe("selectNextVideo", () => {
  it("順番再生は保存した位置から 1 本ずつ進み、最後の次は最初に戻る", () => {
    let memory = EMPTY_VIDEO_MEMORY;
    const order: string[] = [];
    for (let i = 0; i < 4; i++) {
      const pick = selectNextVideo(PLAYLIST, "sequence", memory, NOW);
      order.push(pick!.item.mediaId);
      memory = pick!.memory;
    }
    expect(order).toEqual(["v1", "v2", "v3", "v1"]);
  });

  it("その日外した動画は飛ばし、翌日（日本時間）には戻す", () => {
    const memory = excludeForToday(EMPTY_VIDEO_MEMORY, "v1", NOW);
    expect(selectNextVideo(PLAYLIST, "sequence", memory, NOW)!.item.mediaId).toBe("v2");
    const tomorrow = tokyoDateTime(2026, 9, 26, 10, 0);
    expect(selectNextVideo(PLAYLIST, "sequence", memory, tomorrow)!.item.mediaId).toBe("v1");
  });

  it("全部外していれば null", () => {
    let memory = EMPTY_VIDEO_MEMORY;
    for (const p of PLAYLIST) memory = excludeForToday(memory, p.mediaId, NOW);
    expect(selectNextVideo(PLAYLIST, "sequence", memory, NOW)).toBeNull();
    expect(selectNextVideo(PLAYLIST, "random", memory, NOW)).toBeNull();
  });

  it("ランダムは直前と同じ動画を続けない（ほかに候補があるとき）", () => {
    const memory = { ...EMPTY_VIDEO_MEMORY, lastPlayedMediaId: "v1" };
    for (const r of [0, 0.4, 0.99]) {
      expect(selectNextVideo(PLAYLIST, "random", memory, NOW, () => r)!.item.mediaId).not.toBe("v1");
    }
    expect(selectNextVideo([item("v1")], "random", memory, NOW, () => 0)!.item.mediaId).toBe("v1");
  });
});

describe("isVideoDue", () => {
  const base = {
    video: video(),
    playlistLength: 3,
    visible: true,
    now: NOW,
    testPlay: false,
    startedAt: NOW - 10 * 60,
    lastVideoFinishedAt: null,
    displayWindowStartedAt: null,
  };

  it("開いてから間隔（10 分）が過ぎたら流す。前の動画が終わってからも同じ間隔を待つ", () => {
    expect(isVideoDue(base)).toBe(true);
    expect(isVideoDue({ ...base, now: NOW - 1 })).toBe(false);
    expect(isVideoDue({ ...base, lastVideoFinishedAt: NOW - 5 * 60 })).toBe(false);
    expect(isVideoDue({ ...base, lastVideoFinishedAt: NOW - 10 * 60 })).toBe(true);
  });

  it("テスト表示は間隔を待たずに流す。ただし定期動画が無効・動画なし・表示時間外なら流さない", () => {
    const early = { ...base, now: NOW - 5 * 60, testPlay: true };
    expect(isVideoDue(early)).toBe(true);
    expect(isVideoDue({ ...early, video: video({ enabled: false }) })).toBe(false);
    expect(isVideoDue({ ...early, playlistLength: 0 })).toBe(false);
    expect(isVideoDue({ ...early, visible: false })).toBe(false);
  });

  it("表示時間帯が始まったら、そこから間隔を数える", () => {
    expect(isVideoDue({ ...base, displayWindowStartedAt: NOW - 60 })).toBe(false);
  });
});

describe("parseVideoMemory", () => {
  it("読めない・形が違うときは初期状態（テスト表示は未記録）", () => {
    expect(parseVideoMemory(null)).toEqual(EMPTY_VIDEO_MEMORY);
    expect(parseVideoMemory("{broken")).toEqual(EMPTY_VIDEO_MEMORY);
    expect(parseVideoMemory(JSON.stringify({ sequenceIndex: -1 })).sequenceIndex).toBe(0);
    expect("lastTestPlayProcessedAt" in parseVideoMemory(JSON.stringify({ sequenceIndex: 1 }))).toBe(false);
  });

  it("保存した状態を読み戻す", () => {
    const saved = { ...excludeForToday(EMPTY_VIDEO_MEMORY, "v2", NOW), sequenceIndex: 2, lastTestPlayProcessedAt: NOW };
    expect(parseVideoMemory(JSON.stringify(saved))).toEqual(saved);
  });
});
