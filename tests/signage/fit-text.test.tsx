// @vitest-environment jsdom
/**
 * イベント名を省略せずに出す（components/signage/FitText.tsx。2026-09-29 ユーザー指示「イベントタイトルの表示で省略をなくす」）。
 * 詰め方の順（元のまま → 説明を外す → 字を小さくする → 行を伸ばす）と、行への印（data-wide・data-tall）を確かめる。
 * jsdom には文字の組みが無いので、行数は「必要な行数 × 字の大きさ ÷ 幅の広さ」で作った測り値に差し替える。
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FitText, findFit } from "@/components/signage/FitText";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("findFit", () => {
  it("元のままで入ればそのまま", () => {
    expect(findFit(() => true, { canWiden: true, minFit: 0.72 })).toEqual({ wide: false, fit: 1 });
  });

  it("入らなければ、先に説明を外して幅を広げる（字は小さくしない）", () => {
    expect(findFit((s) => s.wide, { canWiden: true, minFit: 0.72 })).toEqual({ wide: true, fit: 1 });
  });

  it("広げても入らなければ字を少しずつ小さくし、入った大きさで止める。説明が無い行は広げない", () => {
    expect(findFit((s) => s.fit <= 0.8, { canWiden: true, minFit: 0.72 })).toEqual({ wide: true, fit: 0.8 });
    expect(findFit((s) => s.fit <= 0.8, { canWiden: false, minFit: 0.72 })).toEqual({ wide: false, fit: 0.8 });
  });

  it("下限まで小さくしても入らなければ null（呼び出し側が切らずに行を伸ばす）", () => {
    expect(findFit(() => false, { canWiden: true, minFit: 0.72 })).toBeNull();
  });
});

describe("FitText（今後のイベントの行）", () => {
  /** 必要な行数（字が元の大きさ・幅が狭いとき）から、今の字の大きさと幅での行数を返すように測り値を差し替える */
  function fakeLayout(neededLines: number) {
    vi.spyOn(window, "getComputedStyle").mockImplementation(() => ({ lineHeight: "20px" }) as CSSStyleDeclaration);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      const fit = Number(this.style.getPropertyValue("--fit") || "1");
      const wide = this.closest<HTMLElement>("[data-fit-row]")?.dataset.wide === "true";
      const lines = Math.ceil((neededLines * fit) / (wide ? 1.6 : 1) - 1e-9);
      return { height: lines * 20 } as DOMRect;
    });
  }
  const renderRow = (hasDesc: boolean) =>
    render(
      <div data-fit-row data-has-desc={hasDesc ? "true" : "false"} data-testid="row">
        <FitText className="title" fitKey="タイトル" lines={2} minFit={0.72}>
          タイトル
        </FitText>
      </div>,
    );
  const title = (container: HTMLElement) => container.querySelector<HTMLElement>(".title")!;

  it("2 行に入るなら、説明も字もそのまま", () => {
    fakeLayout(2);
    const { container, getByTestId } = renderRow(true);
    expect(getByTestId("row").dataset.wide).toBeUndefined();
    expect(title(container).style.getPropertyValue("--fit")).toBe("1");
  });

  it("3 行になるなら説明を外して幅を使い、字は小さくしない", () => {
    fakeLayout(3);
    const { container, getByTestId } = renderRow(true);
    expect(getByTestId("row").dataset.wide).toBe("true");
    expect(title(container).style.getPropertyValue("--fit")).toBe("1");
  });

  it("説明の無い行は、字を小さくして 2 行に収める", () => {
    fakeLayout(2.5);
    const { container, getByTestId } = renderRow(false);
    expect(getByTestId("row").dataset.wide).toBeUndefined();
    expect(Number(title(container).style.getPropertyValue("--fit"))).toBeLessThanOrEqual(0.8);
    expect(getByTestId("row").dataset.tall).toBeUndefined();
  });

  it("下限まで小さくしても入らなければ、切らずに行を縦に伸ばす", () => {
    fakeLayout(10);
    const { getByTestId } = renderRow(true);
    expect(getByTestId("row").dataset.tall).toBe("true");
    expect(getByTestId("row").textContent).toBe("タイトル");
  });
});
