"use client";

import "@fontsource/line-seed-jp/400.css";
import "@fontsource/line-seed-jp/700.css";
import "@fontsource/kalam/400.css";
import "@fontsource/yusei-magic/400.css";
import { ScaleBox } from "@/components/admin/scale-box";
import { SpotlightCard } from "@/components/signage/SpotlightCard";
import type { SignageSpotlight } from "@/lib/config-schema";
import signage from "@/components/signage/signage.module.css";
import styles from "./spotlight-preview.module.css";

export type SpotlightPreviewProps = {
  payload: Pick<SignageSpotlight, "companyName" | "personName" | "role" | "quote" | "bio" | "tags">;
  photoUrl: string | null;
  logoUrl: string | null;
};

/** 公開フォームのBlob URLと、スタッフ用画像URLのどちらでも同じ掲載枠を描く。 */
export function SpotlightPreview({ payload, photoUrl, logoUrl }: SpotlightPreviewProps) {
  return (
    <div className={styles.preview} aria-label="掲載イメージ">
      <ScaleBox width={516} height={319} initialWidth={288}>
        <div className={`${signage.canvas} ${styles.scene}`}>
          <SpotlightCard
            spotlight={{ item: { ...payload, id: "registration-preview", photo: null, logo: null }, index: 0, count: 1 }}
            photoUrl={photoUrl}
            logoUrl={logoUrl}
          />
        </div>
      </ScaleBox>
    </div>
  );
}
