"use client";

/**
 * 固定サイズのキャンバスを、表示領域（ウィンドウ）に収まるよう CSS transform で拡大縮小して中央に置く。
 *
 * maxHeight を渡すと、ウィンドウがキャンバスより縦長のとき、その高さまでキャンバスを縦に伸ばして
 * 上下の黒い帯を出さない（Web 公開のサイネージ用。2026-09-25 ユーザー指示）。
 * 伸ばした分は CSS 変数 --canvas-extra（px）で中身に渡す。
 */
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import styles from "./signage.module.css";

/** 表示領域に合わせたキャンバスの高さと倍率。高さは height 以上 maxHeight 以下 */
export function fitCanvas(
  frame: { width: number; height: number },
  canvas: { width: number; height: number; maxHeight: number },
): { scale: number; height: number } {
  const height = Math.min(canvas.maxHeight, Math.max(canvas.height, (frame.height / frame.width) * canvas.width));
  return { scale: Math.min(frame.width / canvas.width, frame.height / height), height };
}

export function ScaledCanvas({
  width,
  height,
  maxHeight = height,
  children,
}: {
  width: number;
  height: number;
  maxHeight?: number;
  children: ReactNode;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ scale: 1, height });

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const update = () => {
      const { clientWidth, clientHeight } = frame;
      if (clientWidth > 0 && clientHeight > 0) {
        setBox(fitCanvas({ width: clientWidth, height: clientHeight }, { width, height, maxHeight }));
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [width, height, maxHeight]);

  return (
    <div ref={frameRef} className={styles.frame}>
      <div
        className={styles.scaler}
        style={
          {
            width,
            height: box.height,
            transform: `translate(-50%, -50%) scale(${box.scale})`,
            "--canvas-extra": `${box.height - height}px`,
          } as CSSProperties
        }
        data-scale={box.scale}
      >
        {children}
      </div>
    </div>
  );
}
