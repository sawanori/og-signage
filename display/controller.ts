/**
 * Pi 用表示バンドルとローカルサーバー（raspberry-pi/agent/server.py）とのやりとり。
 *
 * - 起動時に /local/config.json を取得する（失敗したら取得できるまで再試行）。
 * - /local/events（SSE）を購読する。接続直後に現在の遷移イベントと時刻同期状態イベントが
 *   1 回ずつ届く（再読み込みで次の遷移まで黒くならない・時刻未同期の印が出ないのを防ぐため）。
 *   - 遷移 `{transitionId, mode}`: 画面の状態を切り替える。fading_out / fading_in は FADE_MS の演出が
 *     終わったら POST /local/ack `{transitionId, phase: "fade_out_done" | "fade_in_done"}` を送る。
 *   - `{type: "config_updated"}`: /local/config.json を取り直す。
 *   - `{type: "status", timeSynced}`: 時刻同期状態を反映する。
 *   - 切れたら RECONNECT_MS 後に張り直し、張り直せたら config も取り直す（切れている間の更新を取りこぼさないため）。
 * - ACK_INTERVAL_MS ごとに POST /local/ack `{}`（生存応答。60 秒途絶えると Agent が Chromium を再起動する）。
 *
 * fetch と EventSource は差し替えられるように外から受け取る（tests/display/controller.test.ts）。
 */
import type { SignageConfig } from "@/lib/config-schema";

export type DisplayMode = "fading_out" | "playing" | "fading_in" | "display" | "off";

/** 暗転・明転の長さ。画面側の CSS transition と同じ値にする */
export const FADE_MS = 500;
export const ACK_INTERVAL_MS = 5_000;
export const RECONNECT_MS = 2_000;
export const CONFIG_RETRY_MS = 5_000;

export const CONFIG_URL = "/local/config.json";
export const EVENTS_URL = "/local/events";
export const ACK_URL = "/local/ack";

const MODES: readonly DisplayMode[] = ["fading_out", "playing", "fading_in", "display", "off"];

/** EventSource のうち使う分 */
export type EventSourceLike = {
  onopen: ((ev: Event) => unknown) | null;
  onmessage: ((ev: MessageEvent) => unknown) | null;
  onerror: ((ev: Event) => unknown) | null;
  close(): void;
};

export type ControllerDeps = {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  createEventSource: (url: string) => EventSourceLike;
};

export type ControllerCallbacks = {
  onConfig: (config: SignageConfig) => void;
  onMode: (mode: DisplayMode) => void;
  onTimeSynced: (timeSynced: boolean) => void;
};

export type DisplayController = { stop(): void };

export function startDisplayController(callbacks: ControllerCallbacks, deps: ControllerDeps): DisplayController {
  let stopped = false;
  let source: EventSourceLike | null = null;
  let everOpened = false;
  let configRetry: ReturnType<typeof setTimeout> | null = null;
  let reconnect: ReturnType<typeof setTimeout> | null = null;
  let fadeTimer: ReturnType<typeof setTimeout> | null = null;

  const postAck = (body: Record<string, unknown>) =>
    deps
      .fetch(ACK_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      .catch(() => undefined);

  const loadConfig = async () => {
    if (configRetry !== null) {
      clearTimeout(configRetry);
      configRetry = null;
    }
    try {
      const res = await deps.fetch(CONFIG_URL, { cache: "no-store" });
      if (!res.ok) throw new Error(`config ${res.status}`);
      const config = (await res.json()) as SignageConfig;
      if (!stopped) callbacks.onConfig(config);
    } catch {
      if (!stopped) configRetry = setTimeout(loadConfig, CONFIG_RETRY_MS);
    }
  };

  const applyTransition = (transitionId: string | null, mode: DisplayMode) => {
    if (fadeTimer !== null) {
      clearTimeout(fadeTimer);
      fadeTimer = null;
    }
    callbacks.onMode(mode);
    const phase = mode === "fading_out" ? "fade_out_done" : mode === "fading_in" ? "fade_in_done" : null;
    if (phase && transitionId) {
      fadeTimer = setTimeout(() => {
        fadeTimer = null;
        if (!stopped) void postAck({ transitionId, phase });
      }, FADE_MS);
    }
  };

  const handleMessage = (data: string) => {
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof event !== "object" || event === null) return;
    const e = event as { type?: unknown; mode?: unknown; transitionId?: unknown; timeSynced?: unknown };
    if (e.type === "config_updated") {
      void loadConfig();
      return;
    }
    if (e.type === "status") {
      if (typeof e.timeSynced === "boolean") callbacks.onTimeSynced(e.timeSynced);
      return;
    }
    if (typeof e.mode === "string" && (MODES as readonly string[]).includes(e.mode)) {
      applyTransition(typeof e.transitionId === "string" ? e.transitionId : null, e.mode as DisplayMode);
    }
  };

  const connect = () => {
    reconnect = null;
    if (stopped) return;
    const es = deps.createEventSource(EVENTS_URL);
    source = es;
    es.onopen = () => {
      if (everOpened) void loadConfig();
      everOpened = true;
    };
    es.onmessage = (ev) => handleMessage(String(ev.data));
    es.onerror = () => {
      // ブラウザの自動再接続に任せず、閉じて自分で張り直す（503 などで CLOSED のまま止まるのを避ける）
      es.close();
      if (source === es) source = null;
      if (!stopped && reconnect === null) reconnect = setTimeout(connect, RECONNECT_MS);
    };
  };

  void loadConfig();
  connect();
  void postAck({});
  const ackTimer = setInterval(() => void postAck({}), ACK_INTERVAL_MS);

  return {
    stop() {
      stopped = true;
      clearInterval(ackTimer);
      for (const t of [configRetry, reconnect, fadeTimer]) if (t !== null) clearTimeout(t);
      source?.close();
      source = null;
    },
  };
}
