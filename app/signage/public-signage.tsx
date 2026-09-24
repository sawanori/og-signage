"use client";

/**
 * Web 公開のサイネージの表示部分。時計は毎秒進め、データは 30 秒ごとに取り直す。
 *
 * - 縦横は ?layout で固定しなければ、見ている画面（ウィンドウ）の向きに合わせる。
 * - 画像は公開用の中継（/api/signage/media/<mediaId>）で読む。
 * - 全画面表示はブラウザの制約でボタン操作が要る。ボタンはマウスを動かしたときだけ 3 秒出す。
 * - ウィンドウが 16:9 より縦長なら横型を縦に伸ばし、上下の黒い帯を出さない（fillHeight）。
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { SignageScreen } from "@/components/signage/SignageScreen";
import type { MediaRef, SignageConfig } from "@/lib/config-schema";

type Orientation = SignageConfig["device"]["orientation"];

const REFRESH_MS = 30_000;
const PORTRAIT_QUERY = "(orientation: portrait)";

function subscribeViewport(onChange: () => void) {
  const query = window.matchMedia(PORTRAIT_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
const viewportOrientation = (): Orientation => (window.matchMedia(PORTRAIT_QUERY).matches ? "portrait" : "landscape");

export function PublicSignage({
  deviceId,
  initialConfig,
  initialNow,
  layout,
}: {
  deviceId: string;
  initialConfig: SignageConfig;
  initialNow: number;
  layout: Orientation | null;
}) {
  const [config, setConfig] = useState(initialConfig);
  const [now, setNow] = useState(initialNow);
  const [controlsVisible, setControlsVisible] = useState(false);
  // サーバーでは画面の向きが分からないので、端末の向きで描いてから合わせる
  const viewport = useSyncExternalStore(subscribeViewport, viewportOrientation, () => null);

  useEffect(() => {
    const timer = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const url = `/api/signage/config?device=${encodeURIComponent(deviceId)}`;
    const timer = setInterval(async () => {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) return; // 一時的に取れないときは今の表示を続ける
        const next = (await res.json()) as SignageConfig;
        setConfig((prev) => (prev.version === next.version ? prev : next));
      } catch {
        // 通信できないときも今の表示を続ける
      }
    }, REFRESH_MS);
    return () => clearInterval(timer);
  }, [deviceId]);

  useEffect(() => {
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    const show = () => {
      setControlsVisible(true);
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => setControlsVisible(false), 3000);
    };
    window.addEventListener("mousemove", show);
    return () => {
      window.removeEventListener("mousemove", show);
      clearTimeout(hideTimer);
    };
  }, []);

  const resolveMediaUrl = (ref: MediaRef) =>
    `/api/signage/media/${encodeURIComponent(ref.mediaId)}?device=${encodeURIComponent(deviceId)}`;

  return (
    <>
      <SignageScreen
        config={config}
        now={now}
        resolveMediaUrl={resolveMediaUrl}
        orientation={layout ?? viewport ?? config.device.orientation}
        fillHeight
      />
      {controlsVisible ? (
        <button
          type="button"
          onClick={() => void document.documentElement.requestFullscreen?.()}
          className="fixed right-4 bottom-4 z-50 rounded-full bg-black/60 px-4 py-2 text-sm text-white"
        >
          全画面で表示
        </button>
      ) : null}
    </>
  );
}
