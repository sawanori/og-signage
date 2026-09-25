"use client";

/**
 * Web 公開のサイネージ（/signage）の定期動画（2026-09-25 ユーザー指示。Pi のブラウザで /signage を開いて使うため）。
 *
 * - いつ・どれを流すか（次の時刻・次の 1 本・テスト表示）は lib/web-video-schedule.ts。規則は Pi の player.py と同じ。
 * - 次の 1 本は隠した <video preload="auto"> で先に読み込み、時刻になったら canplaythrough を待つ
 *   （20 秒で間に合わなければ今回は見送り、次の間隔で再試行。テスト表示は待たずに再生を試みる）。
 * - 表示を 600ms で黒へ溶かしてから（SignageScreen の fading）動画を画面いっぱいに出し、終わったら表示に戻す。
 * - テスト表示（管理画面のボタン）は、数秒ごとに /api/signage/commands を確かめてすぐ流す。動画を選んで押したときは
 *   その動画を読み込んでから流す（順番の位置は進めない）。定期動画が OFF でも表示時間内なら流す（試せるように）。
 * - 音量は端末の設定（device.volume）。自動再生を断られたらミュートで流し直す（Pi の Chromium は
 *   --autoplay-policy=no-user-gesture-required で起動すれば音も出せる）。
 * - 流せなかった動画（error・映像を読めない・10 秒待っても再生が始まらない・長さ＋10 秒を過ぎても終わらない）は
 *   その日（日本時間）は外す。ブラウザが自動再生を止めたときは動画のせいではないので外さない。
 *   どの待ちにも上限があり、失敗しても必ず表示に戻る（ページが止まったままにならない）。
 * - テスト表示が流せなかったときは、画面の下に理由を数秒出す（押した人がその場で分かるように。定期動画は黙って飛ばす）。
 * - 再生の位置・処理済みのテスト表示・その日外す動画は localStorage に端末 id ごとに覚える。
 */
import { useEffect, useRef, useState } from "react";
import type { MediaRef, PlaylistItem, SignageConfig } from "@/lib/config-schema";
import { isWithinDisplaySchedule } from "@/lib/display-rules";
import {
  consumeTestPlay,
  excludeForToday,
  isVideoDue,
  newerCommands,
  parseVideoMemory,
  pickTestVideo,
  selectNextVideo,
  type VideoMemory,
} from "@/lib/web-video-schedule";

const TICK_MS = 1000;
/** テスト表示の要求を確かめる間隔（config 全体は 30 秒ごと） */
const COMMANDS_POLL_MS = 3000;
const FADE_MS = 600;
const READY_TIMEOUT_MS = 20_000;
/** play() を呼んでからこれだけ待っても再生が始まらなければ、あきらめて表示に戻す */
const PLAY_TIMEOUT_MS = 10_000;
/** 動画の長さをこれだけ過ぎても終わらなければ、止まったとみなす */
const OVERRUN_SECONDS = 10;
/** テスト表示が流せなかった理由を出しておく時間 */
const NOTICE_MS = 12_000;

/** 流せなかった理由。テスト表示のときは画面に出す */
type Failure = "load-error" | "no-video" | "blocked" | "not-started" | "play-error" | "stalled";

export const FAILURE_TEXT: Record<Failure, string> = {
  "load-error": "動画を読み込めませんでした。「動画・メディア」で形式を確認してください",
  "no-video": "このブラウザでは、この動画の映像を再生できません（H.264 の動画にしてください）",
  blocked: "ブラウザが動画の自動再生を止めています。このサイトの自動再生を「許可」にしてください",
  "not-started": "動画の再生が始まりませんでした。ページを再読み込みして、もう一度お試しください",
  "play-error": "動画を再生できませんでした",
  stalled: "動画の再生が途中で止まりました",
};

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

/** ms 待つ（止められたらすぐ戻る） */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done);
  });
}

type StartResult = "ok" | "blocked" | "error" | "timeout";

/**
 * 再生を始める。自動再生の制限で断られたら（blocked）ミュートで流し直す。
 * play() が PLAY_TIMEOUT_MS たっても返らない（ブラウザが動画を始められない）ときは timeout
 */
async function startPlaying(el: HTMLVideoElement, signal: AbortSignal): Promise<StartResult> {
  const attempt = (): Promise<StartResult> =>
    Promise.race([
      el.play().then(
        (): StartResult => "ok",
        (e: unknown): StartResult => (e instanceof DOMException && e.name === "NotAllowedError" ? "blocked" : "error"),
      ),
      sleep(PLAY_TIMEOUT_MS, signal).then((): StartResult => "timeout"),
    ]);
  const first = await attempt();
  if (first !== "blocked" || el.muted) return first;
  el.muted = true;
  return attempt();
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
  // 数秒ごとに確かめているテスト表示の要求
  const commandsRef = useRef<SignageConfig["commands"] | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [shown, setShown] = useState(false);
  // テスト表示が流せなかった理由（数秒で消す）
  const [notice, setNotice] = useState<string | null>(null);

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
    let noticeTimer: ReturnType<typeof setTimeout> | null = null;
    type Upcoming = { item: PlaylistItem; next: Pick<VideoMemory, "sequenceIndex" | "lastPlayedMediaId">; test: boolean };
    let upcoming: Upcoming | null = null;

    const remember = (next: VideoMemory) => {
      memory = next;
      saveMemory(deviceId, next);
    };

    const showNotice = (text: string) => {
      if (noticeTimer) clearTimeout(noticeTimer);
      setNotice(text);
      noticeTimer = setTimeout(() => setNotice(null), NOTICE_MS);
    };

    /** 流せなかった。exclude ならその日は外す。テスト表示なら理由を画面に出す */
    const fail = (item: PlaylistItem, test: boolean, reason: Failure, exclude = true) => {
      console.warn(`[signage-video] 動画 ${item.mediaId} を流せませんでした: ${reason}`);
      if (exclude) remember(excludeForToday(memory, item.mediaId, nowSeconds()));
      lastFinishedAt = nowSeconds();
      if (test) showNotice(FAILURE_TEXT[reason]);
    };

    const playOnce = async ({ item, next, test }: Upcoming) => {
      const el = videoRef.current;
      if (!el) return;
      busy = true;
      try {
        // 前の読み込みに失敗したまま（error）の <video> は、同じ src でも読み直す（そのままでは canplaythrough が来ない）
        if (el.error) el.load();
        if (el.readyState < HTMLMediaElement.HAVE_ENOUGH_DATA) {
          const ready = await waitFor(el, "canplaythrough", READY_TIMEOUT_MS, signal);
          if (signal.aborted) return;
          if (ready === "error") {
            fail(item, test, "load-error");
            return;
          }
          // 間に合わないだけなら、定期動画は今回は見送り（次の間隔で再試行）。テスト表示はそのまま再生を試みる
          // （ブラウザが読み込みを休めていて canplaythrough が来ないことがある。play() で読み込みが再開する）
          if (ready === "timeout" && !test) {
            lastFinishedAt = nowSeconds();
            return;
          }
        }
        // 映像を読めない動画（このブラウザが H.265 に対応していない等）もその日は外す。音声付きだと error は来ず、
        // 映像なし（videoWidth 0）のまま音だけ最後まで流れて、画面が黒くなる（2026-09-25 Chromium で確認）
        if (el.videoWidth === 0) {
          fail(item, test, "no-video");
          return;
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

        const started = await startPlaying(el, signal);
        if (signal.aborted) return;
        if (started !== "ok") {
          el.pause();
          setShown(false);
          fadingRef.current(false);
          // 自動再生を止められたのは動画のせいではないので、その日外さない（許可されれば次は流れる）
          if (started === "blocked") fail(item, test, "blocked", false);
          else fail(item, test, started === "timeout" ? "not-started" : "play-error");
          return;
        }

        const ended = await waitFor(el, "ended", (item.durationSeconds + OVERRUN_SECONDS) * 1000, signal);
        if (signal.aborted) return;
        el.pause();
        setShown(false);
        fadingRef.current(false);
        if (ended !== "ok") {
          fail(item, test, ended === "error" ? "play-error" : "stalled");
          return;
        }
        lastFinishedAt = nowSeconds();
      } finally {
        busy = false;
        upcoming = null;
      }
    };

    const upcomingOf = (pick: { item: PlaylistItem; memory: VideoMemory } | null, test: boolean): Upcoming | null =>
      pick
        ? { item: pick.item, next: { sequenceIndex: pick.memory.sequenceIndex, lastPlayedMediaId: pick.memory.lastPlayedMediaId }, test }
        : null;
    // テスト表示で流す 1 本を <video> に付けた。次の周期で流す（src が付いてから）
    let playTestNext = false;

    const tick = () => {
      if (busy) return;
      const cfg = configRef.current;
      const now = nowSeconds();
      const visible = isWithinDisplaySchedule(cfg.schedule, now, true);
      if (visible && !wasVisible) windowStartedAt = now;
      wasVisible = visible;
      const playlist = cfg.playlist;

      if (playTestNext) {
        playTestNext = false;
        if (upcoming) {
          void playOnce(upcoming);
          return;
        }
      }

      // テスト表示: 要求は流さない状態（動画なし・表示時間外）でも消費する（Pi と同じ）。定期動画が OFF でも流す
      const commands = newerCommands(cfg.commands, commandsRef.current);
      const test = consumeTestPlay(commands.testPlayRequestedAt, memory.lastTestPlayProcessedAt, now);
      if (test.processedAt !== memory.lastTestPlayProcessedAt) remember({ ...memory, lastTestPlayProcessedAt: test.processedAt });
      if (test.play && visible && playlist.length > 0) {
        const pick = upcomingOf(pickTestVideo(playlist, commands.testPlayMediaId, cfg.video.mode, memory, now), true);
        if (pick) {
          upcoming = pick;
          setSrc(resolveRef.current(pick.item));
          playTestNext = true;
          return;
        }
      }

      const active = cfg.video.enabled && playlist.length > 0 && visible;
      if (!active) {
        upcoming = null;
        setSrc(null);
        return;
      }

      // 次の 1 本を決めて先に読み込んでおく（プレイリストから外れたら選び直す）。
      // 選び直した周期では流さない（<video> に新しい src が付いてから、次の周期で判断する）
      const pending = upcoming;
      if (!pending || !playlist.some((p) => p.mediaId === pending.item.mediaId)) {
        const pick = selectNextVideo(playlist, cfg.video.mode, memory, now);
        upcoming = upcomingOf(pick, false);
        setSrc(pick ? resolveRef.current(pick.item) : null);
        return;
      }

      const due = isVideoDue({
        video: cfg.video,
        playlistLength: playlist.length,
        visible,
        now,
        testPlay: false,
        startedAt,
        lastVideoFinishedAt: lastFinishedAt,
        displayWindowStartedAt: windowStartedAt,
      });
      if (due) void playOnce(pending);
    };

    const timer = setInterval(tick, TICK_MS);
    return () => {
      clearInterval(timer);
      if (noticeTimer) clearTimeout(noticeTimer);
      abort.abort();
    };
  }, [deviceId]);

  useEffect(() => {
    const url = `/api/signage/commands?device=${encodeURIComponent(deviceId)}`;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (res.ok) commandsRef.current = (await res.json()) as SignageConfig["commands"];
      } catch {
        // 通信できないときは次の周期でまた確かめる
      }
    }, COMMANDS_POLL_MS);
    return () => clearInterval(timer);
  }, [deviceId]);

  return (
    <>
      {src ? (
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
      ) : null}
      {notice ? (
        <div
          role="status"
          data-testid="video-notice"
          className="pointer-events-none fixed bottom-8 left-1/2 z-50 max-w-[90vw] -translate-x-1/2 rounded-full bg-black/85 px-6 py-3 text-base text-white shadow-lg"
        >
          {notice}
        </div>
      ) : null}
    </>
  );
}
