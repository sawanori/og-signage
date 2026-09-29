"use client";

/**
 * 省略せずに全文を出す文字（2026-09-29 ユーザー指示「イベントタイトルの表示で省略をなくす」）。
 * メンバー紹介のカード（SpotlightCard.tsx）と同じ考え方で、収まらないときは字を少しずつ小さくする（CSS の --fit）。
 * どこまで小さくしても収まらなければ、切らずに全文を出す。
 * - lines を渡したとき（今後のイベントの行）: その行数に収める。行（data-fit-row）に説明の欄があれば、先に説明を外して
 *   その幅を使う（行に data-wide）。最小まで小さくしても収まらなければ、行を縦に伸ばす（行に data-tall）
 * - lines が無いとき（大きな欄のタイトル）: 囲みの欄（data-fit-box）から はみ出さないよう小さくする
 * 画面をサーバーで組み立てるページ（/dev/signage・管理画面のプレビュー）からも使うので、受け取るのは文字と子要素だけ
 */
import { useLayoutEffect, useRef, type ReactNode } from "react";

const STEP = 0.04;

export type FitState = { wide: boolean; fit: number };

/** 収まる最初の状態。元のまま → 説明を外す（外せるとき） → 字を小さくする の順に試す。どれも収まらなければ null */
export function findFit(
  fits: (state: FitState) => boolean,
  { canWiden, minFit }: { canWiden: boolean; minFit: number },
): FitState | null {
  const states: FitState[] = [{ wide: false, fit: 1 }];
  if (canWiden) states.push({ wide: true, fit: 1 });
  for (let fit = Math.round((1 - STEP) * 100) / 100; fit >= minFit - 1e-9; fit = Math.round((fit - STEP) * 100) / 100) {
    states.push({ wide: canWiden, fit });
  }
  return states.find(fits) ?? null;
}

/** 折り返したあとの行数（行の高さで割る）。測れない環境（テストの jsdom）では 1 行とみなす */
function lineCount(el: HTMLElement): number {
  const lineHeight = parseFloat(getComputedStyle(el).lineHeight);
  if (!(lineHeight > 0)) return 1;
  return Math.round(el.getBoundingClientRect().height / lineHeight);
}

export function FitText({
  className,
  children,
  fitKey,
  lines,
  minFit = 0.6,
}: {
  className: string;
  children: ReactNode;
  /** 中身が変わったら測り直すための印（イベント名） */
  fitKey: string;
  /** この行数に収める。無ければ囲みの欄（data-fit-box）に収める */
  lines?: number;
  /** 字を小さくしてよい下限（元の大きさに対する割合） */
  minFit?: number;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const row = lines ? el.closest<HTMLElement>("[data-fit-row]") : null;
    const box = lines ? null : el.closest<HTMLElement>("[data-fit-box]");
    const apply = ({ wide, fit }: FitState) => {
      el.style.setProperty("--fit", String(fit));
      if (!row) return;
      if (wide) row.dataset.wide = "true";
      else delete row.dataset.wide;
    };
    const fits = () => (lines ? lineCount(el) <= lines : !box || box.scrollHeight <= box.clientHeight + 1);
    const run = () => {
      if (row) delete row.dataset.tall;
      const found = findFit(
        (state) => {
          apply(state);
          return fits();
        },
        { canWiden: row?.dataset.hasDesc === "true", minFit },
      );
      if (found) apply(found);
      // 最小の字でも入らない。切らずに、行を縦に伸ばして全文を出す
      else if (row) row.dataset.tall = "true";
    };
    run();
    // 書体が読み込まれると文字の幅が変わるので、読み込み後にもう一度
    let alive = true;
    void document.fonts?.ready.then(() => {
      if (alive) run();
    });
    return () => {
      alive = false;
    };
  }, [fitKey, lines, minFit]);
  return (
    <span ref={ref} className={className}>
      {children}
    </span>
  );
}
