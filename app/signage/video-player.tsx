"use client";

/**
 * Web 公開のサイネージ（/signage）の定期動画（2026-09-25 ユーザー指示。Pi のブラウザで /signage を開いて使うため）。
 *
 * - いつ・どれを流すか（次の時刻・次の 1 本・テスト表示）は lib/web-video-schedule.ts。規則は Pi の player.py と同じ。
 * - 流す動画は丸ごと読み込んで（fetch → Blob → object URL）から流す。読み込みの途中から流すと、通信が再生に
 *   追いつかない動画（ビットレートが高い・Wi-Fi が遅い）が途中で止まるため（2026-09-26 ユーザー報告）。
 *   再生リストの動画は読み込んだものを覚えておき、次からは読み込み直さない。テスト表示は読み込みの進み具合を画面に出す。
 * - 読み込んだ動画は端末のブラウザの中（Cache Storage）にも保存し、ページの再読み込み・再起動のあとも読み込み直さない
 *   （中身が変わったら別の鍵になるよう sha256 を鍵に入れる。再生リストから外れたら消す）。ページを開いたら、再生リストの
 *   動画を 1 本ずつ裏で読み込んでおき、テスト表示もすぐ流せるようにする（2026-09-26 ユーザー指示「キャッシュでスムーズに」）。
 * - 表示を 600ms で黒へ溶かしてから（SignageScreen の fading）動画を画面いっぱいに出し、終わったら表示に戻す。
 *   画面と動画の形が近ければ、余白を出さずに画面いっぱいに広げ、はみ出した分は切る（2026-09-26 ユーザー指示。
 *   ブラウザを最大化した横長の画面で左右に黒い余白が出ていた）。形が大きく違う（縦の画面に横の動画など）ときは全体を収める。
 * - テスト表示（管理画面のボタン）は、数秒ごとに /api/signage/commands を確かめてすぐ流す。動画を選んで押したときは
 *   その動画を読み込んでから流す（順番の位置は進めない）。定期動画が OFF でも表示時間内なら流す（試せるように）。
 * - 音量は端末の設定（device.volume）。自動再生を断られたらミュートで流し直す（Pi の Chromium は
 *   --autoplay-policy=no-user-gesture-required で起動すれば音も出せる）。
 * - 流せなかった動画（読み込めない・映像を読めない・10 秒待っても再生が始まらない・再生位置が 10 秒進まない・
 *   映像が一色の緑にしか描けない）はその日（日本時間）は外す。ブラウザが自動再生を止めたとき・通信が遅くて読み込みが
 *   間に合わないときは動画のせいではないので外さない。再生が遅くても進んでいれば止めない（長さの 3 倍＋10 秒まで）。
 * - 流す前に、読み込み済みの最初のコマを調べ、一色の緑（Linux の Firefox でハードウェアデコードが壊れているときの症状。
 *   2026-09-25 ユーザー報告）なら見せずに飛ばす。再生中には手を入れない（頭に戻すシークもしない）。
 * - 読み込み・再生のエラーはブラウザが返すコードとメッセージを理由に添える（原因の切り分けのため）。
 *   どの待ちにも上限があり、失敗しても必ず表示に戻る（ページが止まったままにならない）。
 * - テスト表示が流せなかったときは、画面の下に理由を数秒出す（押した人がその場で分かるように。定期動画は黙って飛ばす）。
 * - テスト表示の再生の様子（再生位置・コマ数・音声の有無・イベントの順番）を /api/signage/player-log に送る
 *   （端末のブラウザで動画が止まる原因を、現地に行かずに調べるため。2026-09-26 ユーザー報告）。
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
/**
 * 黒になったあと、動画を始めるまで待つ時間。裏のサイネージを隠す描き直し（黒の 0.65 秒後。signage.module.css）を
 * 先に終わらせ、動画の解読の立ち上がりと重ならないようにする（重なると最初の 1 秒にコマが落ちる。2026-09-26）
 */
const SETTLE_MS = 250;
const READY_TIMEOUT_MS = 20_000;
/** play() を呼んでからこれだけ待っても再生が始まらなければ、あきらめて表示に戻す */
const PLAY_TIMEOUT_MS = 10_000;
/** 再生位置がこれだけ進まなければ、止まったとみなす */
const STALL_MS = 10_000;
/** テスト表示の動画の読み込みを待つ上限（丸ごと読み込むため、遅い通信では時間がかかる） */
const TEST_LOAD_TIMEOUT_MS = 120_000;
/** 定期動画の読み込みに失敗したら、これだけ待ってから読み込み直す（通信が一時的に切れただけのことが多い） */
const LOAD_RETRY_MS = 60_000;
/** テスト表示が流せなかった理由を出しておく時間 */
const NOTICE_MS = 12_000;

/** 流せなかった理由。テスト表示のときは画面に出す */
type Failure = "load-error" | "load-slow" | "no-video" | "broken-frames" | "blocked" | "not-started" | "play-error" | "stalled";

export const FAILURE_TEXT: Record<Failure, string> = {
  "load-error": "動画を読み込めませんでした。「動画・メディア」で形式を確認してください",
  "load-slow": "動画の読み込みが 2 分で終わりませんでした。通信が遅いか、動画のビットレートが高すぎます（4Mbps 程度で書き出してください）",
  "no-video": "このブラウザでは、この動画の映像を再生できません（H.264 の動画にしてください）",
  "broken-frames":
    "映像が緑一色にしか描けません。Firefox の about:config で media.hardware-video-decoding.enabled を false にして、Firefox を再起動してください",
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

/**
 * 動画の出し方。画面いっぱいに広げたとき（cover）に見える割合が 75% 以上なら cover（余白なし・はみ出した分は切る）、
 * それより切れてしまうなら contain（全体を収めて余白を出す）
 */
export function videoFit(videoWidth: number, videoHeight: number, screenWidth: number, screenHeight: number): "cover" | "contain" {
  if (!videoWidth || !videoHeight || !screenWidth || !screenHeight) return "cover";
  const video = videoWidth / videoHeight;
  const screen = screenWidth / screenHeight;
  return Math.min(video, screen) / Math.max(video, screen) >= 0.75 ? "cover" : "contain";
}

/** 端末のブラウザの中に動画を保存しておく場所（Cache Storage）の名前 */
const VIDEO_CACHE = "og-signage-videos-v1";

/** 保存の鍵。動画の中身が変わったら別の鍵になるよう sha256 を入れる */
export const videoCacheKey = (item: Pick<PlaylistItem, "mediaId" | "sha256">) =>
  `/__signage-video-cache/${encodeURIComponent(item.mediaId)}/${item.sha256}`;

/** Cache Storage を開く。使えない（http・古いブラウザ・容量不足など）ときは null（毎回ネットから読む） */
async function openVideoCache(): Promise<Cache | null> {
  try {
    return typeof caches === "undefined" ? null : await caches.open(VIDEO_CACHE);
  } catch {
    return null;
  }
}

/** 動画を丸ごと読み込む。進み具合（0〜1）を onProgress で知らせる。読み込めなければ例外 */
async function downloadVideo(url: string, signal: AbortSignal, onProgress: (ratio: number) => void): Promise<Blob> {
  const res = await fetch(url, { signal });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || 0;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total > 0) onProgress(Math.min(1, received / total));
  }
  return new Blob(chunks as BlobPart[], { type: res.headers.get("content-type") ?? "video/mp4" });
}

/**
 * 最後まで流れるのを待つ。再生位置が STALL_MS 進まなければ stalled（遅くても進んでいれば待つ）。
 * 長さの 3 倍＋10 秒を過ぎても終わらなければ stalled
 */
function waitForEnd(el: HTMLVideoElement, durationSeconds: number, signal: AbortSignal): Promise<"ok" | "error" | "stalled"> {
  return new Promise((resolve) => {
    const deadline = Date.now() + (durationSeconds * 3 + 10) * 1000;
    let lastTime = el.currentTime;
    let lastProgressAt = Date.now();
    const done = (result: "ok" | "error" | "stalled") => {
      el.removeEventListener("ended", onEnded);
      el.removeEventListener("error", onError);
      signal.removeEventListener("abort", onAbort);
      clearInterval(check);
      resolve(result);
    };
    const onEnded = () => done("ok");
    const onError = () => done("error");
    const onAbort = () => done("stalled");
    const check = setInterval(() => {
      if (el.currentTime > lastTime + 0.01) {
        lastTime = el.currentTime;
        lastProgressAt = Date.now();
      }
      if (Date.now() - lastProgressAt >= STALL_MS || Date.now() >= deadline) done("stalled");
    }, 1000);
    el.addEventListener("ended", onEnded);
    el.addEventListener("error", onError);
    signal.addEventListener("abort", onAbort);
  });
}

/** 再生の様子の 1 行（再生位置・readyState・networkState・一時停止・ミュート・コマ数） */
function mediaSnapshot(el: HTMLVideoElement): string {
  const quality = typeof el.getVideoPlaybackQuality === "function" ? el.getVideoPlaybackQuality() : null;
  const frames = quality ? `${quality.totalVideoFrames}/${quality.droppedVideoFrames}` : "-";
  return `ct=${el.currentTime.toFixed(2)} rs=${el.readyState} ns=${el.networkState} p=${el.paused ? 1 : 0} m=${el.muted ? 1 : 0} f=${frames}`;
}

/** 動画の情報（大きさ・長さ・音声の有無・ブラウザ独自のコマ数） */
function mediaInfo(el: HTMLVideoElement): Record<string, unknown> {
  const any = el as HTMLVideoElement & Record<string, unknown>;
  const pick = (keys: string[]) => Object.fromEntries(keys.filter((k) => typeof any[k] !== "undefined").map((k) => [k, any[k]]));
  return {
    w: el.videoWidth,
    h: el.videoHeight,
    d: Number.isFinite(el.duration) ? Number(el.duration.toFixed(2)) : String(el.duration),
    ...pick(["mozHasAudio", "mozParsedFrames", "mozDecodedFrames", "mozPresentedFrames", "mozPaintedFrames"]),
    ...pick(["webkitDecodedFrameCount", "webkitDroppedFrameCount", "webkitAudioDecodedByteCount"]),
  };
}

const TRACE_EVENTS = [
  "loadedmetadata",
  "loadeddata",
  "canplay",
  "canplaythrough",
  "play",
  "playing",
  "waiting",
  "stalled",
  "suspend",
  "pause",
  "seeking",
  "seeked",
  "timeupdate",
  "ended",
  "error",
  "emptied",
];

/**
 * テスト表示の再生の様子を記録する。finish で /api/signage/player-log へ送る（失敗しても再生には影響させない）
 */
function startTrace(el: HTMLVideoElement, mediaId: string, deviceId: string) {
  const t0 = Date.now();
  const since = () => ((Date.now() - t0) / 1000).toFixed(1);
  const events: string[] = [];
  const samples: string[] = [];
  let timeupdates = 0;
  const onEvent = (e: Event) => {
    if (e.type === "timeupdate" && ++timeupdates > 3) return; // 進み始めが分かれば十分
    if (events.length < 40) events.push(`${since()} ${e.type} ct=${el.currentTime.toFixed(2)} rs=${el.readyState}`);
  };
  for (const type of TRACE_EVENTS) el.addEventListener(type, onEvent);
  let finished = false;
  return {
    sample(label: string) {
      if (samples.length < 24) samples.push(`${since()} ${label} ${mediaSnapshot(el)}`);
    },
    finish(reason: string) {
      if (finished) return;
      finished = true;
      for (const type of TRACE_EVENTS) el.removeEventListener(type, onEvent);
      const message = JSON.stringify({ mediaId, reason, ua: navigator.userAgent, info: mediaInfo(el), events, samples }).slice(0, 2000);
      void fetch(`/api/signage/player-log?device=${encodeURIComponent(deviceId)}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message }),
        keepalive: true,
      }).catch(() => {});
    },
  };
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

/**
 * 読み込み済みのコマ（流す前の最初のコマ）が一色の緑か（デコーダが壊れているときの症状。正常な動画の最初のコマが
 * 一色の緑であることはまず無い）。同一オリジンの動画だけ調べられる。調べられないときは false（問題なしとして見せる）
 */
export function looksLikeBrokenFrames(el: HTMLVideoElement): boolean {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 32;
    canvas.height = 18;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return false;
    ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const n = data.length / 4;
    let r = 0;
    let g = 0;
    let b = 0;
    for (let i = 0; i < data.length; i += 4) {
      r += data[i];
      g += data[i + 1];
      b += data[i + 2];
    }
    r /= n;
    g /= n;
    b /= n;
    let spread = 0;
    for (let i = 0; i < data.length; i += 4) {
      spread += Math.abs(data[i] - r) + Math.abs(data[i + 1] - g) + Math.abs(data[i + 2] - b);
    }
    return spread / n < 6 && g > r + 30 && g > b + 30;
  } catch {
    return false;
  }
}

/** ブラウザが返した動画のエラー（コードとメッセージ）。理由に添えて、原因の切り分けに使う */
function mediaErrorDetail(el: HTMLVideoElement): string {
  const error = el.error;
  if (!error) return "";
  const names: Record<number, string> = { 1: "中断", 2: "通信", 3: "デコード", 4: "非対応" };
  const message = error.message ? ` ${error.message.slice(0, 160)}` : "";
  return `（エラー ${error.code} ${names[error.code] ?? ""}:${message}）`;
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
  // 動画の出し方（videoFit。流すたびに画面と動画の形から決める）
  const [fit, setFit] = useState<"cover" | "contain">("cover");
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
    type Upcoming = {
      item: PlaylistItem;
      next: Pick<VideoMemory, "sequenceIndex" | "lastPlayedMediaId">;
      test: boolean;
      /** 丸ごと読み込んだ動画（object URL）。読み込み中は null */
      url: string | null;
      /** 読み込みに失敗した */
      failed: boolean;
      /** 読み込みを始めた時刻（ミリ秒） */
      requestedAt: number;
    };
    let upcoming: Upcoming | null = null;
    // 読み込んだ動画（mediaId → object URL）と読み込み中のもの。再生リストから外れたら手放す
    const blobUrls = new Map<string, string>();
    const loading = new Map<string, Promise<string>>();

    const remember = (next: VideoMemory) => {
      memory = next;
      saveMemory(deviceId, next);
    };

    const showNotice = (text: string) => {
      if (noticeTimer) clearTimeout(noticeTimer);
      setNotice(text);
      noticeTimer = setTimeout(() => setNotice(null), NOTICE_MS);
    };
    /** 消えない知らせ（テスト表示の読み込み中）。clearNotice で消す */
    const holdNotice = (text: string) => {
      if (noticeTimer) clearTimeout(noticeTimer);
      noticeTimer = null;
      setNotice(text);
    };
    const clearNotice = () => {
      if (noticeTimer) clearTimeout(noticeTimer);
      noticeTimer = null;
      setNotice(null);
    };

    /**
     * 動画を丸ごと読み込んで object URL にする（読み込み済み・読み込み中ならそれを使う）。
     * 端末に保存してあればそこから読み、無ければネットから読んで保存する
     */
    const load = (item: PlaylistItem, onProgress: (ratio: number) => void): Promise<string> => {
      const cached = blobUrls.get(item.mediaId);
      if (cached) return Promise.resolve(cached);
      const running = loading.get(item.mediaId);
      if (running) return running;
      const job = (async () => {
        const store = await openVideoCache();
        const saved = store ? await store.match(videoCacheKey(item)).catch(() => undefined) : undefined;
        let blob: Blob;
        if (saved) {
          blob = await saved.blob();
          onProgress(1);
        } else {
          blob = await downloadVideo(resolveRef.current(item), signal, onProgress);
          // 保存に失敗しても再生は続ける（次もネットから読むだけ）
          try {
            await store?.put(videoCacheKey(item), new Response(blob, { headers: { "content-type": blob.type || "video/mp4" } }));
          } catch {
            // 容量不足・保存できないブラウザなど
          }
        }
        const url = URL.createObjectURL(blob);
        blobUrls.set(item.mediaId, url);
        return url;
      })();
      loading.set(item.mediaId, job);
      job.then(
        () => loading.delete(item.mediaId),
        () => loading.delete(item.mediaId),
      );
      return job;
    };

    /** 再生リストから外れた動画の object URL を手放し、端末に保存した分も消す（再生リストが変わったときだけ） */
    let savedPlaylist = "";
    const releaseRemoved = (playlist: readonly PlaylistItem[]) => {
      for (const [mediaId, url] of blobUrls) {
        if (!playlist.some((p) => p.mediaId === mediaId)) {
          URL.revokeObjectURL(url);
          blobUrls.delete(mediaId);
        }
      }
      const keys = playlist.map(videoCacheKey);
      const signature = keys.join("\n");
      if (signature === savedPlaylist) return;
      savedPlaylist = signature;
      void openVideoCache().then(async (store) => {
        if (!store) return;
        for (const request of await store.keys()) {
          if (!keys.includes(new URL(request.url).pathname)) await store.delete(request);
        }
      }).catch(() => undefined);
    };

    /** 再生リストの動画を 1 本ずつ裏で読み込んでおく（読み込み中のものがあれば待つ） */
    const preloadNext = (playlist: readonly PlaylistItem[]) => {
      if (loading.size > 0) return;
      const missing = playlist.find((p) => !blobUrls.has(p.mediaId));
      if (missing) load(missing, () => {}).catch(() => undefined);
    };

    /** 次に流す 1 本を決めて読み込みを始める。読み込めたら <video> に付ける */
    const prepare = (pick: { item: PlaylistItem; memory: VideoMemory }, test: boolean) => {
      const u: Upcoming = {
        item: pick.item,
        next: { sequenceIndex: pick.memory.sequenceIndex, lastPlayedMediaId: pick.memory.lastPlayedMediaId },
        test,
        url: blobUrls.get(pick.item.mediaId) ?? null,
        failed: false,
        requestedAt: Date.now(),
      };
      upcoming = u;
      if (u.url) {
        setSrc(u.url);
        return;
      }
      if (test) holdNotice("動画を読み込んでいます…");
      load(u.item, (ratio) => {
        if (test && upcoming === u) holdNotice(`動画を読み込んでいます… ${Math.floor(ratio * 100)}%`);
      }).then(
        (url) => {
          if (upcoming !== u) return;
          u.url = url;
          setSrc(url);
        },
        (e: unknown) => {
          if (upcoming !== u || signal.aborted) return;
          u.failed = true;
          console.warn(`[signage-video] 動画 ${u.item.mediaId} を読み込めませんでした`, e);
        },
      );
    };

    /** 読み込んだ動画が <video> に付いたか（React が描き直したあと） */
    const attached = (u: Upcoming) => u.url !== null && videoRef.current?.getAttribute("src") === u.url;

    /** 流せなかった。exclude ならその日は外す。テスト表示なら理由（detail があればそれも）を画面に出す */
    const fail = (item: PlaylistItem, test: boolean, reason: Failure, exclude = true, detail = "") => {
      console.warn(`[signage-video] 動画 ${item.mediaId} を流せませんでした: ${reason}${detail}`);
      if (exclude) remember(excludeForToday(memory, item.mediaId, nowSeconds()));
      lastFinishedAt = nowSeconds();
      if (test) showNotice(FAILURE_TEXT[reason] + detail);
    };

    const playOnce = async ({ item, next, test }: Upcoming) => {
      const el = videoRef.current;
      if (!el) return;
      busy = true;
      if (test) clearNotice();
      const trace = test ? startTrace(el, item.mediaId, deviceId) : null;
      let outcome = "aborted";
      let sampler: ReturnType<typeof setInterval> | null = null;
      try {
        // 前の読み込みに失敗したまま（error）の <video> は、同じ src でも読み直す（そのままでは canplaythrough が来ない）
        if (el.error) el.load();
        if (el.readyState < HTMLMediaElement.HAVE_ENOUGH_DATA) {
          const ready = await waitFor(el, "canplaythrough", READY_TIMEOUT_MS, signal);
          if (signal.aborted) return;
          if (ready === "error") {
            outcome = "load-error";
            fail(item, test, "load-error", true, mediaErrorDetail(el));
            return;
          }
          // 手元（object URL）にある動画なので普通はすぐ来る。来なければテスト表示はそのまま再生を試みる
          if (ready === "timeout" && !test) {
            lastFinishedAt = nowSeconds();
            return;
          }
        }
        trace?.sample("ready");
        // 映像を読めない動画（このブラウザが H.265 に対応していない等）もその日は外す。音声付きだと error は来ず、
        // 映像なし（videoWidth 0）のまま音だけ最後まで流れて、画面が黒くなる（2026-09-25 Chromium で確認）
        if (el.videoWidth === 0) {
          outcome = "no-video";
          fail(item, test, "no-video");
          return;
        }
        // 流す前に、読み込み済みの最初のコマが描けているか調べる（一色の緑なら見せずに飛ばす）
        if (looksLikeBrokenFrames(el)) {
          outcome = "broken-frames";
          fail(item, test, "broken-frames");
          return;
        }
        remember({ ...memory, ...next });

        // 黒へ溶かす → 裏のサイネージを隠す → 描き直しが落ち着いてから動画を始める
        fadingRef.current(true);
        await sleep(FADE_MS + SETTLE_MS, signal);
        if (signal.aborted) return;
        const volume = configRef.current.device.volume;
        el.volume = volume / 100;
        el.muted = volume === 0;
        setFit(videoFit(el.videoWidth, el.videoHeight, window.innerWidth, window.innerHeight));
        setShown(true);

        const started = await startPlaying(el, signal);
        if (signal.aborted) return;
        trace?.sample(`play:${started}`);
        if (started !== "ok") {
          el.pause();
          setShown(false);
          fadingRef.current(false);
          // 自動再生を止められたのは動画のせいではないので、その日外さない（許可されれば次は流れる）
          outcome = started === "blocked" ? "blocked" : started === "timeout" ? "not-started" : "play-error";
          if (started === "blocked") fail(item, test, "blocked", false);
          else if (started === "timeout") fail(item, test, "not-started");
          else fail(item, test, "play-error", true, mediaErrorDetail(el));
          return;
        }

        // 流れ始めてから 1 秒ごとの様子（テスト表示のとき）
        if (trace) sampler = setInterval(() => trace.sample("tick"), 1000);
        const ended = await waitForEnd(el, item.durationSeconds, signal);
        if (signal.aborted) return;
        el.pause();
        setShown(false);
        fadingRef.current(false);
        if (ended !== "ok") {
          outcome = ended === "error" ? "play-error" : "stalled";
          if (ended === "error") fail(item, test, "play-error", true, mediaErrorDetail(el));
          else fail(item, test, "stalled");
          return;
        }
        outcome = "ok";
        lastFinishedAt = nowSeconds();
      } finally {
        if (sampler) clearInterval(sampler);
        trace?.sample("end");
        trace?.finish(outcome);
        busy = false;
        upcoming = null;
      }
    };

    // テスト表示の 1 本の読み込みを待っている（読み込めて <video> に付いたら流す）
    let waitingTest = false;
    // 定期動画の読み込みに失敗したとき、次に読み込み直してよい時刻（ミリ秒）
    let retryLoadAt = 0;

    const tick = () => {
      if (busy) return;
      const cfg = configRef.current;
      const now = nowSeconds();
      const visible = isWithinDisplaySchedule(cfg.schedule, now, true);
      if (visible && !wasVisible) windowStartedAt = now;
      wasVisible = visible;
      const playlist = cfg.playlist;

      if (waitingTest) {
        const u = upcoming;
        if (!u || !u.test) {
          waitingTest = false;
        } else if (u.failed) {
          // 通信の失敗のことが多いので動画は外さない
          waitingTest = false;
          upcoming = null;
          clearNotice();
          fail(u.item, true, "load-error", false);
          return;
        } else if (attached(u)) {
          waitingTest = false;
          void playOnce(u);
          return;
        } else if (Date.now() - u.requestedAt >= TEST_LOAD_TIMEOUT_MS) {
          // 通信が遅いだけなので動画は外さない
          waitingTest = false;
          upcoming = null;
          clearNotice();
          fail(u.item, true, "load-slow", false);
          return;
        } else {
          return;
        }
      }

      // テスト表示: 要求は流さない状態（動画なし・表示時間外）でも消費する（Pi と同じ）。定期動画が OFF でも流す
      const commands = newerCommands(cfg.commands, commandsRef.current);
      const test = consumeTestPlay(commands.testPlayRequestedAt, memory.lastTestPlayProcessedAt, now);
      if (test.processedAt !== memory.lastTestPlayProcessedAt) remember({ ...memory, lastTestPlayProcessedAt: test.processedAt });
      releaseRemoved(playlist);
      if (visible) preloadNext(playlist);
      if (test.play && visible && playlist.length > 0) {
        const pick = pickTestVideo(playlist, commands.testPlayMediaId, cfg.video.mode, memory, now);
        if (pick) {
          prepare(pick, true);
          waitingTest = true;
          return;
        }
      }

      const active = cfg.video.enabled && playlist.length > 0 && visible;
      if (!active) {
        upcoming = null;
        setSrc(null);
        return;
      }

      // 次の 1 本を決めて先に丸ごと読み込んでおく（プレイリストから外れたら選び直す）。
      // 読み込みが終わって <video> に付くまでは流さない
      const pending = upcoming;
      if (!pending || pending.test || !playlist.some((p) => p.mediaId === pending.item.mediaId)) {
        if (Date.now() < retryLoadAt) return;
        const pick = selectNextVideo(playlist, cfg.video.mode, memory, now);
        if (pick) prepare(pick, false);
        else {
          upcoming = null;
          setSrc(null);
        }
        return;
      }
      if (pending.failed) {
        // 通信が一時的に切れただけのことが多いので外さず、少し待ってから読み込み直す
        upcoming = null;
        retryLoadAt = Date.now() + LOAD_RETRY_MS;
        return;
      }
      if (!attached(pending)) return;

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
      for (const url of blobUrls.values()) URL.revokeObjectURL(url);
      blobUrls.clear();
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
          className="pointer-events-none fixed inset-0 z-40 h-full w-full bg-black"
          style={{ opacity: shown ? 1 : 0, objectFit: fit }}
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
