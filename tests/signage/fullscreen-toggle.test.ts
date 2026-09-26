// @vitest-environment jsdom
/**
 * 右下の WeWork のロゴで全画面表示を入れ・解除する（app/signage/fullscreen-toggle.ts。2026-09-26 ユーザー指示）。
 */
import { describe, expect, it, vi } from "vitest";
import { toggleFullscreenOnLogo } from "@/app/signage/fullscreen-toggle";

function fakeDocument(fullscreen: boolean) {
  return {
    fullscreenElement: fullscreen ? document.body : null,
    exitFullscreen: vi.fn(async () => {}),
    documentElement: { requestFullscreen: vi.fn(async () => {}) },
  };
}

function logo() {
  const wrapper = document.createElement("div");
  wrapper.innerHTML = '<div><img alt="WeWork" data-fullscreen-toggle=""></div><p>ほかの部品</p>';
  return { img: wrapper.querySelector("img")!, other: wrapper.querySelector("p")! };
}

describe("toggleFullscreenOnLogo", () => {
  it("全画面でないときにロゴを押すと全画面にする", () => {
    const doc = fakeDocument(false);
    expect(toggleFullscreenOnLogo(logo().img, doc)).toBe(true);
    expect(doc.documentElement.requestFullscreen).toHaveBeenCalledTimes(1);
    expect(doc.exitFullscreen).not.toHaveBeenCalled();
  });

  it("全画面のときにロゴを押すと解除する", () => {
    const doc = fakeDocument(true);
    expect(toggleFullscreenOnLogo(logo().img, doc)).toBe(true);
    expect(doc.exitFullscreen).toHaveBeenCalledTimes(1);
    expect(doc.documentElement.requestFullscreen).not.toHaveBeenCalled();
  });

  it("ロゴ以外を押しても何もしない", () => {
    const doc = fakeDocument(false);
    expect(toggleFullscreenOnLogo(logo().other, doc)).toBe(false);
    expect(toggleFullscreenOnLogo(null, doc)).toBe(false);
    expect(doc.documentElement.requestFullscreen).not.toHaveBeenCalled();
  });

  it("ブラウザが全画面を断っても例外を出さない", async () => {
    const doc = fakeDocument(false);
    doc.documentElement.requestFullscreen = vi.fn(async () => {
      throw new TypeError("Permissions check failed");
    });
    expect(() => toggleFullscreenOnLogo(logo().img, doc)).not.toThrow();
    await Promise.resolve();
  });
});
