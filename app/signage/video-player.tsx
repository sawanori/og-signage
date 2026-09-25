"use client";

/**
 * Web 公開のサイネージ（/signage）の定期動画（2026-09-25 ユーザー指示。Pi のブラウザで /signage を開いて使うため）。
 *
 * - いつ・どれを流すか（次の時刻・次の 1 本・テスト表示）は lib/web-video-schedule.ts。規則は Pi の player.py と同じ。
 * - 次の 1 本は隠した <video preload="auto"> で先に読み込み、時刻になったら canplaythrough を待つ
 *   （20 秒で間に合わなければ今回は見送り、次の間隔で再試行）。
 * - 表示を 600ms で黒へ溶かしてから（SignageScreen の fading）動画を画面いっぱいに出し、終わったら表示に戻す。
 * - 音量は端末の設定（device.volume）。自動再生を断られたらミュートで流し直す（Pi の Chromium は
 *   --autoplay-policy=no-user-gesture-required で起動すれば音も出せる）。
 * - 流せなかった動画（error・長さ＋10 秒を過ぎても終わらない）はその日（日本時間）は外す。
 * - 再生の位置・処理済みのテスト表示・その日外す動画は localStorage に端末 id ごとに覚える。
 */
import { useEffect, useRef, useState } from "react";
import type { MediaRef, PlaylistItem, SignageConfig } from "@/lib/config-schema";
import { isWithinDisplaySchedule } from "@/lib/display-rules";
import {
  consumeTestPlay,
  excludeForToday,
  isVideoDue,
  parseVideoMemory,
  selectNextVideo,
  type VideoMemory,
} from "@/lib/web-video-schedule";

const TICK_MS = 1000;
const FADE_MS = 600;
const READY_TIMEOUT_MS = 20_000;
/** 動画の長さをこれだけ過ぎても終わらなければ、止まったとみなす */
const OVERRUN_SECONDS = 10;

const nowSeconds = () => Math.floor(Date.now() / 1000);
const storageKey = (deviceId: string) => `og-signage-video:${deviceId}`;

function loadMemory(deviceId: string): VideoMemory {
  try {
    return parseVideoMemory(window.localStorage.getItem(storageKey(deviceId)));
  } catch {
    return parseVideoMemory(null);
  }
}

function saveMemory(deviceId: string, memory: VideoMemory) {
  try {
    window.localStorage.setItem(storageKey(deviceId), JSON.stringify(memory));
  } catch {
    // 保存できなくても再生は続ける（次に開いたときは初めから）
  }
}

/** event（または error）が来るか、ms が過ぎるか、止められるまで待つ */
function waitFor(el: HTMLVideoElement, event: string, ms: number, signal: AbortSignal): Promise<"ok" | "error" | "timeout"> {
  return new Promise((resolve) => {
    const done = (result: "ok" | "error" | "timeout") => {
      el.removeEventListener(event, onOk);
      el.removeEventListener("error", onError);
      signal.removeEventListener("abort", onAbort);
      clearTimeout(timer);
      resolve(result);
    };
    const onOk = () => done("ok");
    const onError = () => done("error");
    const onAbort = () => done("timeout");
    const timer = setTimeout(() => done("timeout"), ms);
    el.addEventListener(event, onOk);
    el.addEventListener("error", onError);
    signal.addEventListener("abort", onAbort);
  });
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

/** 再生を始める。自動再生の制限で断られたらミュートで流し直す */
async function startPlaying(el: HTMLVideoElement): Promise<boolean> {
  try {
    await el.play();
    return true;
  } catch (e) {
    if (!(e instanceof DOMException && e.name === "NotAllowedError") || el.muted) return false;
    el.muted = true;
    try {
      await el.play();
      return true;
    } catch {
      return false;
    }
  }
}

export function VideoPlayer({
  deviceId,
  config,
  resolveMediaUrl,
  onFadingChange,
}: {
  deviceId: string;
  config: SignageConfig;
  resolveMediaUrl: (ref: MediaRef) => string;
  /** 表示を黒へ溶かす（true）・戻す（false）。SignageScreen の fading へ渡す */
  onFadingChange: (fading: boolean) => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  // 30 秒ごとに取り直す config と、親が描くたびに作り直す関数は ref で読む（再生の仕組みを作り直さないため）
  const configRef = useRef(config);
  const resolveRef = useRef(resolveMediaUrl);
  const fadingRef = useRef(onFadingChange);
  const [src, setSrc] = useState<string | null>(null);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    configRef.current = config;
    resolveRef.current = resolveMediaUrl;
    fadingRef.current = onFadingChange;
  });

  useEffect(() => {
    const abort = new AbortController();
    const { signal } = abort;
    const startedAt = nowSeconds();
    let memory = loadMemory(deviceId);
    let lastFinishedAt: number | null = null;
    let windowStartedAt: number | null = null;
    let wasVisible = true; // 開いた時点は「開いた時刻」を起点にする（Pi の起動と同じ）
    let busy = false;
    let upcoming: { item: PlaylistItem; next: Pick<VideoMemory, "sequenceIndex" | "lastPlayedMediaId"> } | null = null;

    const remember = (next: VideoMemory) => {
      memory = next;
      saveMemory(deviceId, next);
    };

    const playOnce = async (item: PlaylistItem, next: Pick<VideoMemory, "sequenceIndex" | "lastPlayedMediaId">) => {
      const el = videoRef.current;
      if (!el) return;
      busy = true;
      try {
        if (el.readyState < HTMLMediaElement.HAVE_ENOUGH_DATA) {
          const ready = await waitFor(el, "canplaythrough", READY_TIMEOUT_MS, signal);
          if (signal.aborted) return;
          if (ready !== "ok") {
            // 読み込めなければその日は外す。間に合わないだけなら今回は見送り、次の間隔で再試行
            if (ready === "error") remember(excludeForToday(memory, item.mediaId, nowSeconds()));
            lastFinishedAt = nowSeconds();
            return;
          }
        }
        remember({ ...memory, ...next });

        fadingRef.current(true);
        await sleep(FADE_MS, signal);
        if (signal.aborted) return;
        const volume = configRef.current.device.volume;
        el.currentTime = 0;
        el.volume = volume / 100;
        el.muted = volume === 0;
        setShown(true);

        const ended = (await startPlaying(el))
          ? await waitFor(el, "ended", (item.durationSeconds + OVERRUN_SECONDS) * 1000, signal)
          : "error";
        if (signal.aborted) return;
        el.pause();
        setShown(false);
        fadingRef.current(false);
        if (ended !== "ok") remember(excludeForToday(memory, item.mediaId, nowSeconds()));
        lastFinishedAt = nowSeconds();
      } finally {
        busy = false;
        upcoming = null;
      }
    };

    const tick = () => {
      if (busy) return;
      const cfg = configRef.current;
      const now = nowSeconds();
      const visible = isWithinDisplaySchedule(cfg.schedule, now, true);
      if (visible && !wasVisible) windowStartedAt = now;
      wasVisible = visible;

      const playlist = cfg.playlist;
      const active = cfg.video.enabled && playlist.length > 0 && visible;
      if (active) {
        // 次の 1 本を決めて先に読み込んでおく（プレイリストから外れたら選び直す）。
        // 選び直した周期では流さない（<video> に新しい src が付いてから、次の周期で判断する）
        const pending = upcoming;
        if (!pending || !playlist.some((p) => p.mediaId === pending.item.mediaId)) {
          const pick = selectNextVideo(playlist, cfg.video.mode, memory, now);
          upcoming = pick
            ? { item: pick.item, next: { sequenceIndex: pick.memory.sequenceIndex, lastPlayedMediaId: pick.memory.lastPlayedMediaId } }
            : null;
          setSrc(pick ? resolveRef.current(pick.item) : null);
          if (pick) return;
        }
      }

      // テスト表示の要求は、流さない状態（無効・動画なし・表示時間外）でも消費する（Pi と同じ）
      const test = consumeTestPlay(cfg.commands.testPlayRequestedAt, memory.lastTestPlayProcessedAt);
      if (test.processedAt !== memory.lastTestPlayProcessedAt) remember({ ...memory, lastTestPlayProcessedAt: test.processedAt });

      if (!active || !upcoming) {
        upcoming = null;
        setSrc(null);
        return;
      }

      const due = isVideoDue({
        video: cfg.video,
        playlistLength: playlist.length,
        visible,
        now,
        testPlay: test.play,
        startedAt,
        lastVideoFinishedAt: lastFinishedAt,
        displayWindowStartedAt: windowStartedAt,
      });
      if (due) void playOnce(upcoming.item, upcoming.next);
    };

    const timer = setInterval(tick, TICK_MS);
    return () => {
      clearInterval(timer);
      abort.abort();
    };
  }, [deviceId]);

  if (!src) return null;
  return (
    <video
      ref={videoRef}
      src={src}
      preload="auto"
      playsInline
      aria-hidden
      data-testid="signage-video"
      data-shown={shown ? "true" : "false"}
      className="pointer-events-none fixed inset-0 z-40 h-full w-full bg-black object-contain"
      style={{ opacity: shown ? 1 : 0 }}
    />
  );
}
