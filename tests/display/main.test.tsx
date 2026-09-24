// @vitest-environment jsdom
/**
 * Pi 用表示ページ本体（display/main.tsx）の統合テスト。
 *
 * server.py は /local/events への新規接続直後に、現在の再生状態機械の遷移イベントと
 * 時刻同期状態イベントを1回ずつ送る（表示ページの再読み込み対策）。ここではその2種類の
 * イベントが実際に画面へ反映されることを、SSE を差し替えて検証する。
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeConfig } from "../fixtures/config.fixture";

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  onopen: ((ev: Event) => unknown) | null = null;
  onmessage: ((ev: MessageEvent) => unknown) | null = null;
  onerror: ((ev: Event) => unknown) | null = null;
  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }
  /** 状態更新を React に確実に反映させるため act() で包む */
  send(data: unknown) {
    act(() => {
      this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) }));
    });
  }
  close() {}
}

/** ScaledCanvas（components/signage）が使う ResizeObserver。jsdom には無いので最小限のダミーを用意する */
class FakeResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeEach(() => {
  FakeEventSource.instances.length = 0;
  vi.stubGlobal("EventSource", FakeEventSource as unknown as typeof EventSource);
  vi.stubGlobal("ResizeObserver", FakeResizeObserver as unknown as typeof ResizeObserver);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/local/config.json") return Response.json(makeConfig());
      return new Response(null, { status: 200 });
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("DisplayApp（display/main.tsx）", () => {
  it("接続直後に届いた playing 状態で、次の遷移を待たずに画面が黒くなる", async () => {
    const { DisplayApp } = await import("@/display/main");
    render(<DisplayApp />);

    expect(FakeEventSource.instances).toHaveLength(1);
    const overlayBefore = screen.getByTestId("display-overlay");
    // 再読み込み直後・遷移イベントが届く前は黒くない
    expect(overlayBefore.getAttribute("data-mode")).toBe("display");

    // server.py が新規接続直後に送る現在状態（動画再生中の再現）
    FakeEventSource.instances[0].send({ transitionId: "t1", mode: "playing" });

    const overlay = screen.getByTestId("display-overlay");
    expect(overlay.getAttribute("data-mode")).toBe("playing");
    expect(overlay.style.opacity).toBe("1");
  });

  it("接続直後に届いた status:false で、時刻未同期の印を表示する", async () => {
    const { DisplayApp } = await import("@/display/main");
    render(<DisplayApp />);

    // config.json の取得（非同期）が終わり SignageScreen が描画されるのを待つ
    await screen.findByTestId("signage-canvas");
    expect(screen.queryByRole("status", { name: "時刻未同期" })).toBeNull();

    FakeEventSource.instances[0].send({ type: "status", timeSynced: false });

    await screen.findByRole("status", { name: "時刻未同期" });
  });
});
