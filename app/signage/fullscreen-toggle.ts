"use client";

/**
 * 公開のサイネージ（/signage）で、右下の WeWork のロゴ（data-fullscreen-toggle を付けた部品）を押すと
 * ブラウザの全画面表示を入れ・もう一度押すと解除する（2026-09-26 ユーザー指示）。
 *
 * - Web ページから Chromium のキオスクモード（起動のしかた）そのものは切り替えられないので、全画面表示（Fullscreen API）を使う。
 *   アドレスバー・タブ・Ubuntu のドックと上のバーが隠れる。Esc でも解除され、ページを読み直すと元に戻る。
 * - 見えるボタンは置かない（2026-09-25 に「全画面で表示」のボタンは外した）。ロゴを押したときだけ働く。
 * - 管理画面のプレビューや Pi の表示部品では使わない（この hook を使う公開のページだけ）。
 */
import { useEffect } from "react";

type FullscreenDocument = Pick<Document, "fullscreenElement" | "exitFullscreen"> & {
  documentElement: Pick<HTMLElement, "requestFullscreen">;
};

/** クリックがロゴなら全画面を切り替える。切り替えたら true */
export function toggleFullscreenOnLogo(target: EventTarget | null, doc: FullscreenDocument): boolean {
  if (!(target instanceof Element) || !target.closest("[data-fullscreen-toggle]")) return false;
  if (doc.fullscreenElement) void doc.exitFullscreen().catch(() => undefined);
  else void doc.documentElement.requestFullscreen().catch(() => undefined);
  return true;
}

export function useFullscreenToggle() {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      toggleFullscreenOnLogo(e.target, document);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);
}
