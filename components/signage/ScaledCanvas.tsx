"use client";

/**
 * 固定サイズのキャンバスを、表示領域（ウィンドウ）に収まるよう CSS transform で拡大縮小して中央に置く。
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import styles from "./signage.module.css";

export function ScaledCanvas({ width, height, children }: { width: number; height: number; children: ReactNode }) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const update = () => {
      const { clientWidth, clientHeight } = frame;
      if (clientWidth > 0 && clientHeight > 0) setScale(Math.min(clientWidth / width, clientHeight / height));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [width, height]);

  return (
    <div ref={frameRef} className={styles.frame}>
      <div
        className={styles.scaler}
        style={{ width, height, transform: `translate(-50%, -50%) scale(${scale})` }}
        data-scale={scale}
      >
        {children}
      </div>
    </div>
  );
}
