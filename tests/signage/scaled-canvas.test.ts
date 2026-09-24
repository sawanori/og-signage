/**
 * 表示領域に合わせたキャンバスの高さと倍率（components/signage/ScaledCanvas.tsx の fitCanvas）。
 * 横型 1920×1080。Web 公開のサイネージは 1440（4:3）まで縦に伸ばして、上下の黒い帯を出さない。
 */
import { describe, expect, it } from "vitest";
import { fitCanvas } from "@/components/signage/ScaledCanvas";

const FILL = { width: 1920, height: 1080, maxHeight: 1440 };
const FIXED = { width: 1920, height: 1080, maxHeight: 1080 };

describe("fitCanvas", () => {
  it("16:9 のウィンドウでは伸ばさない", () => {
    expect(fitCanvas({ width: 1920, height: 1080 }, FILL)).toEqual({ scale: 1, height: 1080 });
    expect(fitCanvas({ width: 1280, height: 720 }, FILL)).toEqual({ scale: 2 / 3, height: 1080 });
  });

  it("16:10 のウィンドウでは 1920×1200 に伸ばし、幅も高さもぴったり収める（帯なし）", () => {
    const { scale, height } = fitCanvas({ width: 1440, height: 900 }, FILL);
    expect(height).toBe(1200);
    expect(scale).toBe(0.75);
    expect(1920 * scale).toBe(1440);
    expect(height * scale).toBe(900);
  });

  it("MacBook の全画面（1512×982）でも上下に帯を出さない", () => {
    const { scale, height } = fitCanvas({ width: 1512, height: 982 }, FILL);
    expect(1920 * scale).toBeCloseTo(1512, 6);
    expect(height * scale).toBeCloseTo(982, 6);
  });

  it("4:3 より縦長のウィンドウは 1440 までで止め、残りは上下の帯（最小限）", () => {
    const { scale, height } = fitCanvas({ width: 1000, height: 1000 }, FILL);
    expect(height).toBe(1440);
    expect(1920 * scale).toBeCloseTo(1000, 6);
    expect(height * scale).toBeCloseTo(750, 6);
  });

  it("16:9 より横長のウィンドウは高さに合わせる（左右に帯）", () => {
    expect(fitCanvas({ width: 2560, height: 1080 }, FILL)).toEqual({ scale: 1, height: 1080 });
  });

  it("伸ばさない設定（端末・管理画面のプレビュー）は今までどおり 1080 のまま収める", () => {
    expect(fitCanvas({ width: 1440, height: 900 }, FIXED)).toEqual({ scale: 0.75, height: 1080 });
  });
});
