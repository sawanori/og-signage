"use client";

/**
 * 固定サイズのキャンバスを、表示領域（ウィンドウ）に収まるよう CSS transform で拡大縮小して中央に置く。
 *
 * maxHeight を渡すと、ウィンドウがキャンバスより縦長のとき、その高さまでキャンバスを縦に伸ばして
 * 上下の黒い帯を出さない。maxWidth を渡すと、ウィンドウが横長のとき、その幅まで横に伸ばして左右の黒い帯を出さない
 * （Web 公開のサイネージ用。2026-09-25 ユーザー指示）。
 * 伸ばした分は CSS 変数 --canvas-extra（縦・px）と --canvas-extra-x（横・px）で中身に渡す。
 */
import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import styles from "./signage.module.css";

/**
 * 表示領域に合わせたキャンバスの幅・高さと倍率。幅は width 以上 maxWidth 以下、高さは height 以上 maxHeight 以下。
 * ウィンドウがキャンバスより横長なら幅だけ、縦長なら高さだけを伸ばす（両方が同時に伸びることはない）
 */
export function fitCanvas(
  frame: { width: number; height: number },
  canvas: { width: number; height: number; maxWidth?: number; maxHeight: number },
): { scale: number; width: number; height: number } {
  const width = Math.min(canvas.maxWidth ?? canvas.width, Math.max(canvas.width, (frame.width / frame.height) * canvas.height));
  const height = Math.min(canvas.maxHeight, Math.max(canvas.height, (frame.height / frame.width) * canvas.width));
  return { scale: Math.min(frame.width / width, frame.height / height), width, height };
}

export function ScaledCanvas({
  width,
  height,
  maxWidth = width,
  maxHeight = height,
  children,
}: {
  width: number;
  height: number;
  maxWidth?: number;
  maxHeight?: number;
  children: ReactNode;
}) {
  const frameRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ scale: 1, width, height });

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const update = () => {
      const { clientWidth, clientHeight } = frame;
      if (clientWidth > 0 && clientHeight > 0) {
        setBox(fitCanvas({ width: clientWidth, height: clientHeight }, { width, height, maxWidth, maxHeight }));
      }
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [width, height, maxWidth, maxHeight]);

  return (
    <div ref={frameRef} className={styles.frame}>
      <div
        className={styles.scaler}
        style={
          {
            width: box.width,
            height: box.height,
            transform: `translate(-50%, -50%) scale(${box.scale})`,
            "--canvas-extra": `${box.height - height}px`,
            "--canvas-extra-x": `${box.width - width}px`,
          } as CSSProperties
        }
        data-scale={box.scale}
      >
        {children}
      </div>
    </div>
  );
}
