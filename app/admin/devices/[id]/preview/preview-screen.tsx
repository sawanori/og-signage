"use client";

/**
 * 端末プレビューの表示部分。時計を毎秒進め、画像は管理用素材 API で読む。
 *
 * SignageScreen の拡大縮小枠は position: fixed で画面全体を覆うため、transform を持つ箱で包み、
 * その箱を基準に収める（transform を持つ祖先は fixed の基準になる）。
 */
import { useEffect, useState } from "react";
import { CANVAS_SIZE, SignageScreen } from "@/components/signage/SignageScreen";
import type { MediaRef, SignageConfig } from "@/lib/config-schema";

const resolveMediaUrl = (ref: MediaRef) => `/api/media/${encodeURIComponent(ref.mediaId)}/file`;

export function PreviewScreen({ config, initialNow }: { config: SignageConfig; initialNow: number }) {
  const [now, setNow] = useState(initialNow);

  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, []);

  const size = CANVAS_SIZE[config.device.orientation];
  return (
    <div
      data-testid="device-preview"
      style={{
        position: "relative",
        height: "calc(100vh - 140px)",
        maxWidth: "100%",
        aspectRatio: `${size.width} / ${size.height}`,
        transform: "translateZ(0)",
        overflow: "hidden",
        background: "#000",
      }}
    >
      <SignageScreen config={config} now={now} resolveMediaUrl={resolveMediaUrl} />
    </div>
  );
}
