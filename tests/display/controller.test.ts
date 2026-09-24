/**
 * Pi 用表示バンドルの SSE / ack 処理（display/controller.ts）。
 * fetch と EventSource を差し替え、タイマーは偽物で進める。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ACK_INTERVAL_MS,
  CONFIG_RETRY_MS,
  FADE_MS,
  RECONNECT_MS,
  startDisplayController,
  type DisplayController,
  type DisplayMode,
  type EventSourceLike,
} from "@/display/controller";
import { makeConfig } from "../fixtures/config.fixture";

class FakeEventSource implements EventSourceLike {
  onopen: ((ev: Event) => unknown) | null = null;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  closed = false;
  constructor(readonly url: string) {}
  open() {
    this.onopen?.(new Event("open"));
  }
  send(data: unknown) {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) }));
  }
  fail() {
    this.onerror?.(new Event("error"));
  }
  close() {
    this.closed = true;
  }
}

type Call = { url: string; init?: RequestInit };

function setup(options: { configStatus?: number[] } = {}) {
  const calls: Call[] = [];
  const statuses = [...(options.configStatus ?? [])];
  const config = makeConfig();
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url === "/local/config.json") {
      const status = statuses.shift() ?? 200;
      return status === 200 ? Response.json(config) : new Response(null, { status });
    }
    return new Response(null, { status: 200 });
  });
  const sources: FakeEventSource[] = [];
  const configs: unknown[] = [];
  const modes: DisplayMode[] = [];
  const controller = startDisplayController(
    { onConfig: (c) => configs.push(c), onMode: (m) => modes.push(m) },
    {
      fetch,
      createEventSource: (url) => {
        const es = new FakeEventSource(url);
        sources.push(es);
        return es;
      },
    },
  );
  const acks = () =>
    calls.filter((c) => c.url === "/local/ack").map((c) => JSON.parse(String(c.init?.body)) as Record<string, unknown>);
  const configFetches = () => calls.filter((c) => c.url === "/local/config.json").length;
  return { controller, config, sources, configs, modes, acks, configFetches };
}

let current: DisplayController | null = null;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  current?.stop();
  current = null;
  vi.useRealTimers();
});

describe("起動", () => {
  it("/local/config.json を取得して渡し、/local/events を購読する", async () => {
    const t = setup();
    current = t.controller;
    await vi.advanceTimersByTimeAsync(0);
    expect(t.configs).toEqual([t.config]);
    expect(t.sources.map((s) => s.url)).toEqual(["/local/events"]);
  });

  it("config が取れなければ取れるまで再試行する", async () => {
    const t = setup({ configStatus: [503, 404] });
    current = t.controller;
    await vi.advanceTimersByTimeAsync(0);
    expect(t.configs).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(CONFIG_RETRY_MS);
    expect(t.configs).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(CONFIG_RETRY_MS);
    expect(t.configs).toEqual([t.config]);
    expect(t.configFetches()).toBe(3);
  });
});

describe("生存応答", () => {
  it("起動時と 5 秒ごとに POST /local/ack {} を送る", async () => {
    const t = setup();
    current = t.controller;
    await vi.advanceTimersByTimeAsync(0);
    expect(t.acks()).toEqual([{}]);
    await vi.advanceTimersByTimeAsync(ACK_INTERVAL_MS * 3);
    expect(t.acks()).toEqual([{}, {}, {}, {}]);
  });

  it("停止後は送らない", async () => {
    const t = setup();
    await vi.advanceTimersByTimeAsync(0);
    t.controller.stop();
    await vi.advanceTimersByTimeAsync(ACK_INTERVAL_MS * 3);
    expect(t.acks()).toEqual([{}]);
    expect(t.sources[0].closed).toBe(true);
  });
});

describe("遷移", () => {
  it("fading_out は暗転し終えた（500ms）後に fade_out_done を返す", async () => {
    const t = setup();
    current = t.controller;
    await vi.advanceTimersByTimeAsync(0);
    t.sources[0].send({ transitionId: "t1", mode: "fading_out" });
    expect(t.modes).toEqual(["fading_out"]);
    await vi.advanceTimersByTimeAsync(FADE_MS - 1);
    expect(t.acks().filter((a) => a.phase)).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.acks().filter((a) => a.phase)).toEqual([{ transitionId: "t1", phase: "fade_out_done" }]);
  });

  it("playing → fading_in → display の順に画面を切り替え、明転後に fade_in_done を返す", async () => {
    const t = setup();
    current = t.controller;
    await vi.advanceTimersByTimeAsync(0);
    t.sources[0].send({ transitionId: "t1", mode: "playing" });
    t.sources[0].send({ transitionId: "t2", mode: "fading_in" });
    await vi.advanceTimersByTimeAsync(FADE_MS);
    t.sources[0].send({ transitionId: null, mode: "display" });
    expect(t.modes).toEqual(["playing", "fading_in", "display"]);
    expect(t.acks().filter((a) => a.phase)).toEqual([{ transitionId: "t2", phase: "fade_in_done" }]);
  });

  it("off は画面を真っ黒にし、ack の phase は送らない", async () => {
    const t = setup();
    current = t.controller;
    await vi.advanceTimersByTimeAsync(0);
    t.sources[0].send({ transitionId: "t9", mode: "off" });
    await vi.advanceTimersByTimeAsync(FADE_MS * 2);
    expect(t.modes).toEqual(["off"]);
    expect(t.acks().filter((a) => a.phase)).toEqual([]);
  });

  it("演出中に次の遷移が来たら、前の遷移の完了は送らない", async () => {
    const t = setup();
    current = t.controller;
    await vi.advanceTimersByTimeAsync(0);
    t.sources[0].send({ transitionId: "t1", mode: "fading_out" });
    await vi.advanceTimersByTimeAsync(FADE_MS / 2);
    t.sources[0].send({ transitionId: "t2", mode: "display" });
    await vi.advanceTimersByTimeAsync(FADE_MS * 2);
    expect(t.acks().filter((a) => a.phase)).toEqual([]);
  });

  it("不明な mode・壊れた JSON は無視する", async () => {
    const t = setup();
    current = t.controller;
    await vi.advanceTimersByTimeAsync(0);
    t.sources[0].send({ transitionId: "t1", mode: "unknown" });
    t.sources[0].onmessage?.(new MessageEvent("message", { data: "{not json" }));
    expect(t.modes).toEqual([]);
  });
});

describe("config の更新", () => {
  it("config_updated で /local/config.json を取り直す", async () => {
    const t = setup();
    current = t.controller;
    await vi.advanceTimersByTimeAsync(0);
    t.sources[0].send({ type: "config_updated", version: "abc" });
    await vi.advanceTimersByTimeAsync(0);
    expect(t.configFetches()).toBe(2);
    expect(t.configs).toHaveLength(2);
  });
});

describe("再接続", () => {
  it("SSE が切れたら閉じて張り直し、張り直せたら config を取り直す", async () => {
    const t = setup();
    current = t.controller;
    await vi.advanceTimersByTimeAsync(0);
    t.sources[0].open();
    expect(t.configFetches()).toBe(1); // 初回の open では取り直さない

    t.sources[0].fail();
    expect(t.sources[0].closed).toBe(true);
    await vi.advanceTimersByTimeAsync(RECONNECT_MS - 1);
    expect(t.sources).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.sources).toHaveLength(2);

    t.sources[1].open();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.configFetches()).toBe(2);

    // 張り直した接続の遷移も処理する
    t.sources[1].send({ transitionId: "t3", mode: "fading_out" });
    await vi.advanceTimersByTimeAsync(FADE_MS);
    expect(t.acks().filter((a) => a.phase)).toEqual([{ transitionId: "t3", phase: "fade_out_done" }]);
  });

  it("停止後は張り直さない", async () => {
    const t = setup();
    await vi.advanceTimersByTimeAsync(0);
    t.controller.stop();
    t.sources[0].fail();
    await vi.advanceTimersByTimeAsync(RECONNECT_MS * 2);
    expect(t.sources).toHaveLength(1);
  });
});
