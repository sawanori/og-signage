// @vitest-environment jsdom
/**
 * Web 公開のサイネージの定期動画（app/signage/video-player.tsx）。
 * 動画は丸ごと読み込んでから流す。どの待ちにも上限があり、流せなくても必ず表示に戻る。
 * テスト表示が流せなかったときは理由を画面に出す。
 * jsdom の <video> は再生できないので、読み込み済み（readyState）・映像の幅（videoWidth）・再生位置・play を差し替える。
 */
import { Blob as NodeBlob } from "node:buffer";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FAILURE_TEXT, VideoPlayer, looksLikeBrokenFrames, videoCacheKey, videoFit } from "@/app/signage/video-player";
import type { SignageConfig } from "@/lib/config-schema";
import { tokyoDateTime } from "@/lib/dates";
import { makeConfig, mediaRef } from "../fixtures/config.fixture";

const NOW = tokyoDateTime(2026, 9, 25, 10, 0);
const DEVICE_ID = "dev_test";
const STORAGE_KEY = `og-signage-video:${DEVICE_ID}`;

/** 定期動画は OFF にして、テスト表示（管理画面の「サイネージで再生」）の 1 本だけを流す */
const testPlayConfig = (overrides: Partial<SignageConfig> = {}) =>
  makeConfig({
    schedule: [],
    video: { enabled: false, intervalMinutes: 10, mode: "sequence" },
    playlist: [{ ...mediaRef("med_hevc", 1), durationSeconds: 15 }],
    commands: { testPlayRequestedAt: NOW - 5, testPlayMediaId: null },
    ...overrides,
  });

let videoWidth = 1920;
let playImpl: () => Promise<void> = async () => {};
/** play() が呼ばれたときのミュート状態（呼ばれた順） */
let playCalls: boolean[] = [];
/** <video> が前の読み込みに失敗したまま（error）か */
let hasError = false;
/** 再生位置（秒）。テストで進める */
let playhead = 0;
/** 動画の取得（/media/...）の応答。既定は 1000 バイトの中身 */
let mediaResponse: () => Promise<Response> = async () =>
  new Response(new Uint8Array(1000), { headers: { "content-type": "video/mp4", "content-length": "1000" } });
let mediaFetches = 0;
/** 動画を取りに行ったときの cache の指定（呼ばれた順） */
let mediaCacheModes: (RequestCache | undefined)[] = [];
/** /api/signage/player-log に送った中身（テスト表示の再生の様子） */
let playerLogs: { reason: string; events: string[]; samples: string[]; info: Record<string, unknown> }[] = [];
/** 読み込み済みの最初のコマの色（[R, G, B]。null なら canvas が使えない＝調べられない） */
let framePixel: [number, number, number] | null = null;
const stubbed: [object, string, PropertyDescriptor | undefined][] = [];
function stub(proto: object, key: string, descriptor: PropertyDescriptor) {
  stubbed.push([proto, key, Object.getOwnPropertyDescriptor(proto, key)]);
  Object.defineProperty(proto, key, { configurable: true, ...descriptor });
}

/** 前に開いたことがある端末（まだ処理していないテスト表示の要求を 1 回流す） */
function openedBefore() {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ sequenceIndex: 0, lastPlayedMediaId: null, lastTestPlayProcessedAt: null, excluded: { dateKey: "", mediaIds: [] } }),
  );
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW * 1000 });
  videoWidth = 1920;
  playImpl = async () => {};
  playCalls = [];
  hasError = false;
  playhead = 0;
  mediaFetches = 0;
  mediaCacheModes = [];
  playerLogs = [];
  mediaResponse = async () => new Response(new Uint8Array(1000), { headers: { "content-type": "video/mp4", "content-length": "1000" } });
  stub(HTMLMediaElement.prototype, "currentTime", { get: () => playhead, set: (v: number) => (playhead = v) });
  framePixel = null;
  stub(HTMLCanvasElement.prototype, "getContext", {
    value: function (this: HTMLCanvasElement) {
      if (!framePixel) return null;
      const [r, g, b] = framePixel;
      return {
        drawImage: () => {},
        getImageData: (_x: number, _y: number, w: number, h: number) => {
          const data = new Uint8ClampedArray(w * h * 4);
          for (let i = 0; i < data.length; i += 4) {
            data[i] = r;
            data[i + 1] = g;
            data[i + 2] = b;
            data[i + 3] = 255;
          }
          return { data };
        },
      };
    },
  });
  stub(HTMLMediaElement.prototype, "readyState", { get: () => HTMLMediaElement.HAVE_ENOUGH_DATA });
  stub(HTMLMediaElement.prototype, "error", { get: () => (hasError ? { code: 3, message: "NS_ERROR_DOM_MEDIA_DECODE_ERR (0x806e0004)" } : null) });
  stub(HTMLMediaElement.prototype, "load", { value: vi.fn() });
  stub(HTMLMediaElement.prototype, "play", {
    value: vi.fn(function (this: HTMLMediaElement) {
      playCalls.push(this.muted);
      return playImpl();
    }),
  });
  stub(HTMLMediaElement.prototype, "pause", { value: vi.fn() });
  stub(HTMLVideoElement.prototype, "videoWidth", { get: () => videoWidth });
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  for (const [proto, key, original] of stubbed.splice(0).reverse()) {
    if (original) Object.defineProperty(proto, key, original);
    else delete (proto as Record<string, unknown>)[key];
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  window.localStorage.clear();
});

/**
 * 100ms ずつ進める（act ごとに描き直すので、周期の間に <video> が付く。まとめて進めると描き直しが最後になる）。
 * テスト表示は 1 秒後の周期で src が付き、2 秒後の周期で流し始める。黒へ溶かす 0.6 秒と、裏の画面を隠して落ち着くまでの
 * 0.25 秒を経て 2.85 秒で見える
 */
async function advance(ms: number) {
  for (let t = 0; t < ms; t += 100) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
  }
}

function renderPlayer(config: SignageConfig) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith("/media/")) {
        mediaFetches += 1;
        mediaCacheModes.push(init?.cache);
        return mediaResponse();
      }
      if (String(input).startsWith("/api/signage/player-log")) {
        playerLogs.push(JSON.parse(JSON.parse(String(init?.body)).message));
        return new Response(null, { status: 204 });
      }
      return Response.json(config.commands);
    }),
  );
  const onFadingChange = vi.fn();
  render(
    <VideoPlayer
      deviceId={DEVICE_ID}
      config={config}
      resolveMediaUrl={(ref) => `/media/${ref.mediaId}`}
      onFadingChange={onFadingChange}
    />,
  );
  return onFadingChange;
}

const excluded = () => (JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}").excluded?.mediaIds ?? []) as string[];
const shown = () => screen.queryByTestId("signage-video")?.getAttribute("data-shown") ?? "false";
const notice = () => screen.queryByTestId("video-notice")?.textContent ?? null;

describe("VideoPlayer", () => {
  it("映像を読める動画は、表示を黒へ溶かしてから画面いっぱいに出し、終わったら戻す", async () => {
    openedBefore();
    const onFadingChange = renderPlayer(testPlayConfig());
    await advance(4000);

    expect(shown()).toBe("true");
    expect(onFadingChange).toHaveBeenLastCalledWith(true);

    await act(async () => {
      fireEvent.ended(screen.getByTestId("signage-video"));
    });
    expect(shown()).toBe("false");
    expect(onFadingChange).toHaveBeenLastCalledWith(false);
    expect(notice()).toBeNull();
    expect(excluded()).toEqual([]);
  });

  it("映像を読めない動画（videoWidth 0）は出さずにその日は外し、テスト表示なら理由を出す", async () => {
    openedBefore();
    videoWidth = 0;
    const onFadingChange = renderPlayer(testPlayConfig());
    await advance(3000);

    expect(onFadingChange).not.toHaveBeenCalled();
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    expect(shown()).toBe("false");
    expect(excluded()).toEqual(["med_hevc"]);
    expect(notice()).toBe(FAILURE_TEXT["no-video"]);
  });

  it("play() が 10 秒たっても返らなければ、あきらめて表示に戻し、その日は外す（ページが止まらない）", async () => {
    openedBefore();
    playImpl = () => new Promise(() => {});
    const onFadingChange = renderPlayer(testPlayConfig());
    await advance(3000);
    // 黒へ溶かして再生を始めようとしている
    expect(shown()).toBe("true");
    expect(onFadingChange).toHaveBeenLastCalledWith(true);

    await advance(10_500);
    expect(shown()).toBe("false");
    expect(onFadingChange).toHaveBeenLastCalledWith(false);
    expect(excluded()).toEqual(["med_hevc"]);
    expect(notice()).toBe(FAILURE_TEXT["not-started"]);

    // 理由は 12 秒で消える
    await advance(12_500);
    expect(notice()).toBeNull();
  });

  it("ブラウザが自動再生を止めた（ミュートでも断られた）ときは、動画のせいではないので外さずに理由を出す", async () => {
    openedBefore();
    playImpl = () => Promise.reject(new DOMException("autoplay blocked", "NotAllowedError"));
    // 音量ありで始め、断られたらミュートでもう一度試す（音量 0 なら最初からミュートなので 1 回だけ）
    const config = testPlayConfig();
    const onFadingChange = renderPlayer({ ...config, device: { ...config.device, volume: 50 } });
    await advance(3000);

    expect(playCalls).toEqual([false, true]);
    expect(shown()).toBe("false");
    expect(onFadingChange).toHaveBeenLastCalledWith(false);
    expect(excluded()).toEqual([]);
    expect(notice()).toBe(FAILURE_TEXT.blocked);
  });

  it("定期動画が流せなかったときは黙って外す（理由は出さない）", async () => {
    openedBefore();
    playImpl = () => new Promise(() => {});
    renderPlayer(
      testPlayConfig({
        video: { enabled: true, intervalMinutes: 10, mode: "sequence" },
        commands: { testPlayRequestedAt: null, testPlayMediaId: null },
      }),
    );
    // 間隔（10 分）が過ぎるまでは流さない
    await act(async () => {
      await vi.advanceTimersByTimeAsync(598_000);
    });
    expect(shown()).toBe("false");
    await advance(14_000);
    expect(shown()).toBe("false");
    expect(excluded()).toEqual(["med_hevc"]);
    expect(notice()).toBeNull();
  });

  it("最初のコマが一色の緑にしか描けないときは、黒へ溶かさずに飛ばし、その日は外して理由を出す（黒一色は普通の始まりなので飛ばさない）", async () => {
    openedBefore();
    framePixel = [0, 135, 0];
    const onFadingChange = renderPlayer(testPlayConfig());
    await advance(4000);
    expect(shown()).toBe("false");
    expect(onFadingChange).not.toHaveBeenCalled();
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    expect(excluded()).toEqual(["med_hevc"]);
    expect(notice()).toBe(FAILURE_TEXT["broken-frames"]);
    cleanup();
    window.localStorage.clear();

    openedBefore();
    framePixel = [0, 0, 0];
    renderPlayer(testPlayConfig());
    await advance(4000);
    expect(shown()).toBe("true");
    expect(excluded()).toEqual([]);
  });

  it("黒になってすぐは始めず、裏の画面を隠す描き直しが落ち着いてから（黒の 0.85 秒後に）動画を始める", async () => {
    openedBefore();
    const onFadingChange = renderPlayer(testPlayConfig());
    await advance(2700);
    // 黒へ溶かし始めているが、まだ動画は始めない
    expect(onFadingChange).toHaveBeenLastCalledWith(true);
    expect(playCalls).toEqual([]);
    expect(shown()).toBe("false");
    await advance(300);
    expect(playCalls).toHaveLength(1);
    expect(shown()).toBe("true");
  });

  it("videoFit: 画面と動画の形が近ければ画面いっぱい（cover）、大きく違えば全体を収める（contain）", () => {
    // ブラウザを最大化した横長の画面（1920×968）に 16:9 の動画: 上下を 1 割ほど切って余白なし
    expect(videoFit(1920, 1080, 1920, 968)).toBe("cover");
    expect(videoFit(1920, 1080, 1920, 1080)).toBe("cover");
    expect(videoFit(1920, 1080, 1440, 900)).toBe("cover");
    // 縦の画面に横の動画: 7 割近く切れてしまうので全体を収める
    expect(videoFit(1920, 1080, 1080, 1920)).toBe("contain");
    // 大きさが分からないときは画面いっぱい
    expect(videoFit(0, 0, 1920, 1080)).toBe("cover");
  });

  it("流すときは画面の形に合わせて出し方を決める（横長の画面では余白なし）", async () => {
    openedBefore();
    const size = { w: window.innerWidth, h: window.innerHeight };
    Object.assign(window, { innerWidth: 1920, innerHeight: 968 });
    renderPlayer(testPlayConfig());
    await advance(4000);
    expect(shown()).toBe("true");
    expect((screen.getByTestId("signage-video") as HTMLVideoElement).style.objectFit).toBe("cover");
    Object.assign(window, { innerWidth: size.w, innerHeight: size.h });
  });

  it("looksLikeBrokenFrames: 一色の緑だけを壊れた映像とみなす", () => {
    const el = document.createElement("video");
    framePixel = [0, 135, 0];
    expect(looksLikeBrokenFrames(el)).toBe(true);
    framePixel = [255, 255, 255];
    expect(looksLikeBrokenFrames(el)).toBe(false);
    framePixel = [40, 120, 60];
    expect(looksLikeBrokenFrames(el)).toBe(true);
    framePixel = [120, 140, 130];
    expect(looksLikeBrokenFrames(el)).toBe(false);
    framePixel = null;
    expect(looksLikeBrokenFrames(el)).toBe(false);
  });

  it("再生中にブラウザがエラーを出したら表示に戻し、理由にエラーのコードとメッセージを添える", async () => {
    openedBefore();
    const onFadingChange = renderPlayer(testPlayConfig());
    await advance(3000);
    expect(shown()).toBe("true");
    hasError = true;
    await act(async () => {
      fireEvent.error(screen.getByTestId("signage-video"));
    });
    expect(shown()).toBe("false");
    expect(onFadingChange).toHaveBeenLastCalledWith(false);
    expect(excluded()).toEqual(["med_hevc"]);
    expect(notice()).toBe(`${FAILURE_TEXT["play-error"]}（エラー 3 デコード: NS_ERROR_DOM_MEDIA_DECODE_ERR (0x806e0004)）`);
  });

  it("前の読み込みに失敗したまま（error）の <video> は、読み直してから流す", async () => {
    openedBefore();
    hasError = true;
    renderPlayer(testPlayConfig());
    await advance(4000);
    expect(HTMLMediaElement.prototype.load).toHaveBeenCalledTimes(1);
    expect(shown()).toBe("true");
  });

  it("動画は丸ごと読み込んでから（object URL で）流し、同じ動画は読み込み直さない（2026-09-26 ユーザー報告）", async () => {
    openedBefore();
    renderPlayer(testPlayConfig());
    await advance(4000);
    const video = screen.getByTestId("signage-video");
    expect(video.getAttribute("src")).toMatch(/^blob:/);
    expect(shown()).toBe("true");
    expect(mediaFetches).toBe(1);
    // ブラウザの通常のキャッシュには入れない（写しは Cache Storage の 1 つだけ）
    expect(mediaCacheModes).toEqual(["no-store"]);
    await act(async () => {
      fireEvent.ended(video);
    });
    expect(shown()).toBe("false");
  });

  it("テスト表示は読み込みの進み具合を画面に出し、読み込めたら流す", async () => {
    openedBefore();
    let release: () => void = () => {};
    mediaResponse = () =>
      new Promise<Response>((resolve) => {
        release = () =>
          resolve(new Response(new Uint8Array(1000), { headers: { "content-type": "video/mp4", "content-length": "1000" } }));
      });
    renderPlayer(testPlayConfig());
    await advance(5000);
    expect(notice()).toBe("動画を読み込んでいます…");
    expect(shown()).toBe("false");
    await act(async () => {
      release();
    });
    await advance(3000);
    expect(shown()).toBe("true");
    expect(notice()).toBeNull();
  });

  it("テスト表示の動画を読み込めなければ理由を出し、通信の失敗なので動画は外さない", async () => {
    openedBefore();
    mediaResponse = async () => new Response("", { status: 500 });
    renderPlayer(testPlayConfig());
    await advance(4000);
    expect(shown()).toBe("false");
    expect(notice()).toBe(FAILURE_TEXT["load-error"]);
    expect(excluded()).toEqual([]);
  });

  it("テスト表示の読み込みが 2 分で終わらなければ、あきらめて理由を出す（動画は外さない）", async () => {
    openedBefore();
    mediaResponse = () => new Promise<Response>(() => {});
    renderPlayer(testPlayConfig());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(119_000);
    });
    expect(notice()).toBe("動画を読み込んでいます…");
    await advance(3000);
    expect(notice()).toBe(FAILURE_TEXT["load-slow"]);
    expect(excluded()).toEqual([]);
  });

  it("再生が遅くても進んでいれば、長さ＋10 秒を過ぎても止めない", async () => {
    openedBefore();
    renderPlayer(testPlayConfig());
    await advance(4000);
    expect(shown()).toBe("true");
    // 15 秒の動画が半分の速さで進む（30 秒かかる）
    for (let i = 0; i < 30; i++) {
      playhead += 0.5;
      await advance(1000);
    }
    expect(shown()).toBe("true");
    await act(async () => {
      fireEvent.ended(screen.getByTestId("signage-video"));
    });
    expect(shown()).toBe("false");
    expect(excluded()).toEqual([]);
    expect(notice()).toBeNull();
  });

  it("再生位置が 10 秒進まなければ止まったとみなし、表示に戻して理由を出す", async () => {
    openedBefore();
    renderPlayer(testPlayConfig());
    await advance(4000);
    playhead = 3;
    await advance(1000);
    expect(shown()).toBe("true");
    await advance(11_000);
    expect(shown()).toBe("false");
    expect(excluded()).toEqual(["med_hevc"]);
    expect(notice()).toBe(FAILURE_TEXT.stalled);
  });

  it("テスト表示の再生の様子（結果・イベント・1 秒ごとの様子）を player-log に送る。定期動画では送らない", async () => {
    openedBefore();
    renderPlayer(testPlayConfig());
    await advance(4000);
    playhead = 0.04;
    await advance(12_000);
    expect(notice()).toBe(FAILURE_TEXT.stalled);
    expect(playerLogs).toHaveLength(1);
    const [log] = playerLogs;
    expect(log.reason).toBe("stalled");
    expect(log.samples.some((line) => line.includes("play:ok"))).toBe(true);
    expect(log.samples.some((line) => line.includes("tick ct=0.04"))).toBe(true);
    expect(log.info).toMatchObject({ w: 1920 });
    cleanup();
    window.localStorage.clear();

    playerLogs = [];
    openedBefore();
    renderPlayer(
      testPlayConfig({
        video: { enabled: true, intervalMinutes: 10, mode: "sequence" },
        commands: { testPlayRequestedAt: null, testPlayMediaId: null },
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(601_000);
    });
    await advance(3000);
    expect(shown()).toBe("true");
    await act(async () => {
      fireEvent.ended(screen.getByTestId("signage-video"));
    });
    expect(playerLogs).toHaveLength(0);
  });

  describe("端末のブラウザの中への保存（Cache Storage。2026-09-26 ユーザー指示）", () => {
    // jsdom の Blob は stream() が無く Response に入れられないので、ブラウザと同じく入れられる Node の Blob を使う
    beforeEach(() => {
      vi.stubGlobal("Blob", NodeBlob);
    });

    /** 最小限の Cache Storage（鍵は URL のパス） */
    function fakeCaches() {
      const entries = new Map<string, Blob>();
      const store = {
        match: vi.fn(async (key: string) => (entries.has(key) ? new Response(entries.get(key)) : undefined)),
        put: vi.fn(async (key: string, res: Response) => {
          entries.set(key, await res.blob());
        }),
        keys: vi.fn(async () => [...entries.keys()].map((key) => new Request(`http://localhost${key}`))),
        delete: vi.fn(async (req: Request) => entries.delete(new URL(req.url).pathname)),
      };
      vi.stubGlobal("caches", { open: vi.fn(async () => store) });
      return { entries, store };
    }

    it("ネットから読んだ動画を保存し、再読み込みのあとは保存した分を使って読み込み直さない", async () => {
      const { entries } = fakeCaches();
      const config = testPlayConfig();
      openedBefore();
      renderPlayer(config);
      await advance(4000);
      expect(shown()).toBe("true");
      expect(mediaFetches).toBe(1);
      expect([...entries.keys()]).toEqual([videoCacheKey(config.playlist[0])]);
      cleanup();

      // ページを開き直して、新しいテスト表示の要求
      window.localStorage.clear();
      openedBefore();
      mediaFetches = 0;
      fakeCachesKeep(entries);
      renderPlayer(testPlayConfig({ commands: { testPlayRequestedAt: NOW - 1, testPlayMediaId: null } }));
      await advance(4000);
      expect(shown()).toBe("true");
      expect(mediaFetches).toBe(0);
    });

    it("再生リストから外れた動画は保存から消す", async () => {
      const { entries } = fakeCaches();
      entries.set("/__signage-video-cache/med_old/" + "a".repeat(64), new Blob(["old"]));
      renderPlayer(testPlayConfig({ commands: { testPlayRequestedAt: null, testPlayMediaId: null } }));
      await advance(3000);
      expect([...entries.keys()].some((key) => key.includes("med_old"))).toBe(false);
    });

    it("ページを開いたら、再生リストの動画を 1 本ずつ裏で読み込んでおく（定期動画が OFF でも、テスト表示に備えて）", async () => {
      fakeCaches();
      const config = testPlayConfig({
        commands: { testPlayRequestedAt: null, testPlayMediaId: null },
        playlist: [
          { ...mediaRef("med_a", 1), durationSeconds: 15 },
          { ...mediaRef("med_b", 2), durationSeconds: 15 },
        ],
      });
      renderPlayer(config);
      await advance(5000);
      expect(mediaFetches).toBe(2);
      expect(shown()).toBe("false");
    });

    /** 開き直したページでも同じ保存場所を使う */
    function fakeCachesKeep(entries: Map<string, Blob>) {
      const store = {
        match: vi.fn(async (key: string) => (entries.has(key) ? new Response(entries.get(key)) : undefined)),
        put: vi.fn(async (key: string, res: Response) => {
          entries.set(key, await res.blob());
        }),
        keys: vi.fn(async () => [...entries.keys()].map((key) => new Request(`http://localhost${key}`))),
        delete: vi.fn(async (req: Request) => entries.delete(new URL(req.url).pathname)),
      };
      vi.stubGlobal("caches", { open: vi.fn(async () => store) });
    }
  });

  it("初めて開いたときでも、1 分以内のテスト表示の要求は流す（古い要求は流さない）", async () => {
    renderPlayer(testPlayConfig({ commands: { testPlayRequestedAt: NOW - 30, testPlayMediaId: null } }));
    await advance(4000);
    expect(shown()).toBe("true");
    cleanup();
    window.localStorage.clear();

    renderPlayer(testPlayConfig({ commands: { testPlayRequestedAt: NOW - 120, testPlayMediaId: null } }));
    await advance(4000);
    expect(shown()).toBe("false");
  });
});
