// @vitest-environment jsdom
/**
 * Web 公開のサイネージの定期動画（app/signage/video-player.tsx）。
 * 映像を読めない動画（H.265 に対応していないブラウザ等）は、音だけ流して画面を黒くせず、その日は外す。
 * jsdom の <video> は再生できないので、読み込み済み（readyState）・映像の幅（videoWidth）・play を差し替える。
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VideoPlayer } from "@/app/signage/video-player";
import { tokyoDateTime } from "@/lib/dates";
import { makeConfig, mediaRef } from "../fixtures/config.fixture";

const NOW = tokyoDateTime(2026, 9, 25, 10, 0);
const DEVICE_ID = "dev_test";
const STORAGE_KEY = `og-signage-video:${DEVICE_ID}`;

// 定期動画は OFF にして、テスト表示（管理画面の「サイネージで再生」）の 1 本だけを流す
const config = makeConfig({
  schedule: [],
  video: { enabled: false, intervalMinutes: 10, mode: "sequence" },
  playlist: [{ ...mediaRef("med_hevc", 1), durationSeconds: 15 }],
  commands: { testPlayRequestedAt: NOW - 5, testPlayMediaId: null },
});

let videoWidth = 1920;
const stubbed: [object, string, PropertyDescriptor | undefined][] = [];
function stub(proto: object, key: string, descriptor: PropertyDescriptor) {
  stubbed.push([proto, key, Object.getOwnPropertyDescriptor(proto, key)]);
  Object.defineProperty(proto, key, { configurable: true, ...descriptor });
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW * 1000 });
  stub(HTMLMediaElement.prototype, "readyState", { get: () => HTMLMediaElement.HAVE_ENOUGH_DATA });
  stub(HTMLMediaElement.prototype, "play", { value: vi.fn(async () => {}) });
  stub(HTMLMediaElement.prototype, "pause", { value: vi.fn() });
  stub(HTMLVideoElement.prototype, "videoWidth", { get: () => videoWidth });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json(config.commands)),
  );
  // 前に開いたことがある端末（まだ処理していないテスト表示の要求を 1 回流す）
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({ sequenceIndex: 0, lastPlayedMediaId: null, lastTestPlayProcessedAt: null, excluded: { dateKey: "", mediaIds: [] } }),
  );
});

afterEach(() => {
  cleanup();
  for (const [proto, key, original] of stubbed.splice(0).reverse()) {
    if (original) Object.defineProperty(proto, key, original);
    else delete (proto as Record<string, unknown>)[key];
  }
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.localStorage.clear();
});

/** 100ms ずつ進める（act ごとに描き直すので、周期の間に <video> が付く。まとめて進めると描き直しが最後になる） */
async function advance(ms: number) {
  for (let t = 0; t < ms; t += 100) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });
  }
}

function renderPlayer() {
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

describe("VideoPlayer", () => {
  it("映像を読める動画は、表示を黒へ溶かしてから画面いっぱいに出し、終わったら戻す", async () => {
    videoWidth = 1920;
    const onFadingChange = renderPlayer();
    await advance(3000);

    expect(screen.getByTestId("signage-video").getAttribute("data-shown")).toBe("true");
    expect(onFadingChange).toHaveBeenLastCalledWith(true);

    await act(async () => {
      fireEvent.ended(screen.getByTestId("signage-video"));
    });
    expect(screen.getByTestId("signage-video").getAttribute("data-shown")).toBe("false");
    expect(onFadingChange).toHaveBeenLastCalledWith(false);
  });

  it("映像を読めない動画（videoWidth 0）は出さずに、その日は外す（音だけ流れて画面が黒くならない）", async () => {
    videoWidth = 0;
    const onFadingChange = renderPlayer();
    await advance(3000);

    expect(onFadingChange).not.toHaveBeenCalled();
    expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled();
    expect(screen.queryByTestId("signage-video")?.getAttribute("data-shown") ?? "false").toBe("false");
    const memory = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    expect(memory.excluded.mediaIds).toEqual(["med_hevc"]);
  });
});
