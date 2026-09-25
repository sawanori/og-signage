// @vitest-environment jsdom
/**
 * Web 公開のサイネージの定期動画（app/signage/video-player.tsx）。
 * どの待ちにも上限があり、流せなくても必ず表示に戻る。テスト表示が流せなかったときは理由を画面に出す。
 * jsdom の <video> は再生できないので、読み込み済み（readyState）・映像の幅（videoWidth）・play を差し替える。
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FAILURE_TEXT, VideoPlayer, looksLikeBrokenFrames } from "@/app/signage/video-player";
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
 * テスト表示は 1 秒後の周期で src が付き、2 秒後の周期で流し始める。黒へ溶かす 0.6 秒を経て 2.6 秒で見える
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
    vi.fn(async () => Response.json(config.commands)),
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
