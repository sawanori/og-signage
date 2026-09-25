"use client";

/**
 * Web 公開のサイネージの表示部分。時計は毎秒進め、データは 30 秒ごとに取り直す。
 *
 * - 縦横は ?layout で固定しなければ、見ている画面（ウィンドウ）の向きに合わせる。
 * - 画像は公開用の中継（/api/signage/media/<mediaId>）で読む。
 * - 全画面のボタンは置かない（2026-09-25 ユーザー指示で削除）。Pi では Chromium を --kiosk で起動して全画面にする。
 * - ウィンドウが 16:9 より縦長なら横型を縦に伸ばし、上下の黒い帯を出さない（fillHeight）。
 * - 管理画面の「定期動画の設定」どおりに動画を流す（video-player.tsx。Pi のブラウザで開いて使うため）。
 */
import { useEffect, useState, useSyncExternalStore } from "react";
import { SignageScreen } from "@/components/signage/SignageScreen";
import type { MediaRef, SignageConfig } from "@/lib/config-schema";
import { VideoPlayer } from "./video-player";

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
  // 動画へ切り替える前後に表示を黒へ溶かす（VideoPlayer が切り替える）
  const [fading, setFading] = useState(false);
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

  const resolveMediaUrl = (ref: MediaRef) =>
    `/api/signage/media/${encodeURIComponent(ref.mediaId)}?device=${encodeURIComponent(deviceId)}`;

  return (
    <>
      <SignageScreen
        config={config}
        now={now}
        resolveMediaUrl={resolveMediaUrl}
        orientation={layout ?? viewport ?? config.device.orientation}
        fading={fading}
        fillHeight
      />
      <VideoPlayer deviceId={deviceId} config={config} resolveMediaUrl={resolveMediaUrl} onFadingChange={setFading} />
    </>
  );
}
