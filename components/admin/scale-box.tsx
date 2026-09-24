"use client";

/**
 * 固定サイズの中身を、置き場所の幅に合わせて縮小する（高さは比率から決まる）。
 * 初回描画は initialWidth で縮尺を決め、描画後に実際の幅で合わせ直す。
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

export function ScaleBox({
  width,
  height,
  initialWidth,
  children,
}: {
  width: number;
  height: number;
  initialWidth: number;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(initialWidth / width);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      if (el.clientWidth > 0) setScale(el.clientWidth / width);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(el);
    return () => observer.disconnect();
  }, [width]);

  return (
    <div ref={ref} style={{ position: "relative", width: "100%", height: height * scale, overflow: "hidden" }}>
      <div style={{ width, height, transform: `scale(${scale})`, transformOrigin: "0 0" }}>{children}</div>
    </div>
  );
}
