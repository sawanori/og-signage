"use client";

/**
 * メンバー紹介のカード（横型の右上。2026-09-26 ユーザー指示の見本どおり）。
 * 左に写真（ひとことを手書き風の文字で重ねる。2026-09-27 ユーザー指示）、右に 会社名（右上にロゴ）・お名前「さん」・肩書き・紹介文・タグ。
 * 1 人ずつ時刻で切り替える（spotlightIndex）。
 * 左右の矢印と下の点は出さない（2026-09-26 ユーザー指示）。
 * 文字は文字数で省略しない（2026-09-26 ユーザー指示「企業名が文字数で省略されるのはあり得ない」）。長いものは折り返し、
 * それでもカードに入りきらないときだけ、文字の組み全体を少しずつ小さくして全文を収める（CSS の --fit。60% まで）
 * 画面をサーバーで組み立てるページ（確認用の /dev/signage）からも使うので、画像の URL は関数ではなく文字列で受け取る
 */
import { useLayoutEffect, useRef } from "react";
import { COPY } from "./copy";
import type { SignageView } from "./model";
import styles from "./signage.module.css";

const MIN_FIT = 0.6;
const FIT_STEP = 0.05;

/** 中身がはみ出さなくなるまで --fit を小さくする（はみ出さなければ 1 のまま） */
function fitToBox(el: HTMLElement) {
  let fit = 1;
  el.style.setProperty("--fit", "1");
  while (el.scrollHeight > el.clientHeight && fit > MIN_FIT) {
    fit = Math.max(MIN_FIT, Math.round((fit - FIT_STEP) * 100) / 100);
    el.style.setProperty("--fit", String(fit));
  }
}

export function SpotlightCard({
  spotlight,
  photoUrl,
  logoUrl,
}: {
  spotlight: SignageView["spotlight"];
  /** 写真・ロゴの URL（無ければ null） */
  photoUrl: string | null;
  logoUrl: string | null;
}) {
  const textRef = useRef<HTMLDivElement>(null);
  const quoteRef = useRef<HTMLParagraphElement>(null);
  const item = spotlight?.item ?? null;
  useLayoutEffect(() => {
    const boxes = [textRef.current, quoteRef.current].filter((el): el is HTMLDivElement | HTMLParagraphElement => el !== null);
    if (boxes.length === 0) return;
    boxes.forEach(fitToBox);
    // 書体が読み込まれると文字の幅が変わるので、読み込み後にもう一度
    let alive = true;
    void document.fonts?.ready.then(() => {
      if (alive) boxes.forEach(fitToBox);
    });
    return () => {
      alive = false;
    };
  }, [item]);

  if (!spotlight || !item) {
    return (
      <div className={styles.lSpot} data-testid="spotlight">
        <div className={styles.lSpotEmpty}>{COPY.noSpotlight}</div>
      </div>
    );
  }
  const fade = spotlight.count > 1 ? styles.heroFade : "";
  return (
    <div className={styles.lSpot} data-testid="spotlight">
      <div key={item.id} className={`${styles.lSpotBody} ${fade}`}>
        <div className={styles.lSpotPhoto} data-has-image={photoUrl ? "true" : "false"}>
          {photoUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- オフライン配信のため素の img
            <img className={styles.cover} src={photoUrl} alt="" draggable={false} />
          ) : null}
          {item.quote ? (
            <p ref={quoteRef} className={styles.lSpotQuote}>
              「{item.quote}」
            </p>
          ) : null}
        </div>
        <div ref={textRef} className={styles.lSpotText}>
          {/* ロゴは会社名の右上に浮かせ、長い会社名はロゴの下まで回り込んで折り返す */}
          <div className={styles.lSpotCompany}>
            {logoUrl ? (
              // eslint-disable-next-line @next/next/no-img-element -- オフライン配信のため素の img
              <img src={logoUrl} alt="" className={styles.lSpotLogo} />
            ) : null}
            {item.companyName}
          </div>
          <div className={styles.lSpotName}>
            {item.personName}
            <span className={styles.lSpotSan}>{COPY.spotlightHonorific}</span>
          </div>
          {item.role ? <div className={styles.lSpotRole}>{item.role}</div> : null}
          {item.bio ? <p className={styles.lSpotBio}>{item.bio}</p> : null}
          {item.tags.length > 0 ? (
            <div className={styles.lSpotTags}>
              {item.tags.map((tag, i) => (
                <span key={i}>{tag}</span>
              ))}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
