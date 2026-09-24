/**
 * Pi 用の表示ページ（静的バンドル。npm run build:display で dist-display/ に出力）。
 *
 * Pi のローカルサーバー（raspberry-pi/agent/server.py）から配信され、同じオリジンの /local/* だけを読む。
 * 外部 URL は一切読まない（フォントも @fontsource からバンドルに同梱）。
 */
import { useEffect, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import { SignageScreen } from "@/components/signage/SignageScreen";
import type { MediaRef, SignageConfig } from "@/lib/config-schema";
import { FADE_MS, startDisplayController, type DisplayMode } from "./controller";

const resolveMediaUrl = (ref: MediaRef) => `/local/media/${ref.sha256}`;

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** 動画の前後と表示時間外に画面を覆う黒 */
function overlayStyle(mode: DisplayMode): CSSProperties {
  const black = mode === "fading_out" || mode === "playing" || mode === "off";
  return {
    position: "fixed",
    inset: 0,
    background: "#000",
    zIndex: 100,
    pointerEvents: "none",
    opacity: black ? 1 : 0,
    // off は即座に真っ黒。それ以外は暗転・明転を FADE_MS で行う
    transition: mode === "off" ? "none" : `opacity ${FADE_MS}ms linear`,
  };
}

export function DisplayApp() {
  const [config, setConfig] = useState<SignageConfig | null>(null);
  const [mode, setMode] = useState<DisplayMode>("display");
  // 接続直後に status イベントが届くまでの既定値は「同期済み」（安全側：印を誤って出し続けない）。
  const [timeSynced, setTimeSynced] = useState(true);
  const [now, setNow] = useState(nowSeconds);

  useEffect(() => {
    const controller = startDisplayController(
      { onConfig: setConfig, onMode: setMode, onTimeSynced: setTimeSynced },
      { fetch: (input, init) => fetch(input, init), createEventSource: (url) => new EventSource(url) },
    );
    return () => controller.stop();
  }, []);

  useEffect(() => {
    const timer = setInterval(() => setNow(nowSeconds()), 1000);
    return () => clearInterval(timer);
  }, []);

  return (
    <>
      {config ? (
        <SignageScreen config={config} now={now} resolveMediaUrl={resolveMediaUrl} timeSynced={timeSynced} />
      ) : null}
      <div style={overlayStyle(mode)} data-mode={mode} data-testid="display-overlay" />
    </>
  );
}

// テスト（tests/display/）から DisplayApp を直接 render できるよう、
// #root が存在するとき（実機・Vite ビルドの index.html）だけ自動マウントする。
const rootEl = document.getElementById("root");
if (rootEl) {
  createRoot(rootEl).render(<DisplayApp />);
}
