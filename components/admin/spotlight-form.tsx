"use client";

/**
 * メンバー紹介の入力欄（spotlights-view.tsx の「メンバーを追加」「編集」で開く）。
 * 見た目と操作はお知らせの入力欄（notices-view.tsx）にそろえ、写真・ロゴは画像欄の共通部品（MediaUploadField）を使う。
 * 文字数の上限は lib/validators.ts の spotlightInputSchema と同じ値。
 */
import { useEffect, useRef, useState } from "react";
import type { SpotlightRow } from "@/lib/services/spotlights";
import { SPOTLIGHT_BIO_MAX, SPOTLIGHT_QUOTE_MAX, SPOTLIGHT_TAG_MAX, SPOTLIGHT_TAGS_MAX, countChars } from "@/lib/validators";
import { MediaUploadField, mediaThumbnailUrl } from "./media-upload-field";
import styles from "./settings.module.css";

const IMAGE_HINT = "JPEG・PNG・WebP（20MBまで）";

export type SpotlightFormState = {
  id: string | null;
  companyName: string;
  personName: string;
  role: string;
  quote: string;
  bio: string;
  /** タグの入力欄 3 つ分。空欄は送るときに除く */
  tags: string[];
  photoMediaId: string | null;
  photoPreviewUrl: string | null;
  logoMediaId: string | null;
  logoPreviewUrl: string | null;
  enabled: boolean;
  revision: number;
};

/** タグの欄はいつも上限の数だけ出す（足りない分は空欄） */
function tagSlots(tags: readonly string[]): string[] {
  return Array.from({ length: SPOTLIGHT_TAGS_MAX }, (_, i) => tags[i] ?? "");
}

export function emptySpotlightForm(): SpotlightFormState {
  return {
    id: null,
    companyName: "",
    personName: "",
    role: "",
    quote: "",
    bio: "",
    tags: tagSlots([]),
    photoMediaId: null,
    photoPreviewUrl: null,
    logoMediaId: null,
    logoPreviewUrl: null,
    enabled: true,
    revision: 0,
  };
}

export function toSpotlightForm(s: SpotlightRow): SpotlightFormState {
  return {
    id: s.id,
    companyName: s.companyName,
    personName: s.personName,
    role: s.role ?? "",
    quote: s.quote ?? "",
    bio: s.bio ?? "",
    tags: tagSlots(s.tags),
    photoMediaId: s.photoMediaId,
    photoPreviewUrl: s.photoMediaId ? mediaThumbnailUrl(s.photoMediaId) : null,
    logoMediaId: s.logoMediaId,
    logoPreviewUrl: s.logoMediaId ? mediaThumbnailUrl(s.logoMediaId) : null,
    enabled: s.enabled,
    revision: s.revision,
  };
}

const blankToNull = (value: string) => (value.trim() === "" ? null : value);

/** Server Action に渡す形（revision は編集のときに呼び出し元が足す）。任意の文字は空欄なら null、空のタグ欄は除く */
export function toSpotlightInput(form: SpotlightFormState) {
  return {
    companyName: form.companyName,
    personName: form.personName,
    role: blankToNull(form.role),
    quote: blankToNull(form.quote),
    bio: blankToNull(form.bio),
    tags: form.tags.map((t) => t.trim()).filter((t) => t !== ""),
    photoMediaId: form.photoMediaId,
    logoMediaId: form.logoMediaId,
    enabled: form.enabled,
  };
}

/** 送る前に文字数を確かめる（サーバーでも同じ上限で検証する）。問題がなければ null */
export function spotlightFormError(form: SpotlightFormState): string | null {
  if (countChars(form.quote) > SPOTLIGHT_QUOTE_MAX) return `ひとことは${SPOTLIGHT_QUOTE_MAX}文字以内で入力してください`;
  if (countChars(form.bio) > SPOTLIGHT_BIO_MAX) return `紹介文は${SPOTLIGHT_BIO_MAX}文字以内で入力してください`;
  return null;
}

export function SpotlightForm({
  form,
  onChange,
  error,
  pending,
  onSave,
  onCancel,
}: {
  form: SpotlightFormState;
  /** 変えた欄だけを渡す。親は最新の入力に重ねる（アップロードを待つあいだに書いた内容を消さないため） */
  onChange: (patch: Partial<SpotlightFormState>) => void;
  error: string | null;
  pending: boolean;
  onSave: () => void;
  onCancel: () => void;
}) {
  // 写真とロゴは同時にアップロードできるので、片方が終わっても保存できないよう欄ごとに持つ
  const [uploading, setUploading] = useState({ photo: false, logo: false });
  const busy = pending || uploading.photo || uploading.logo;
  // 閉じたり別の人の編集に切り替えたりしたあと（呼び出し元が key で作り直す）に届いたアップロードの結果は、
  // 今開いている人の入力に入れない
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const patchImage = (patch: Partial<SpotlightFormState>) => {
    if (alive.current) onChange(patch);
  };
  const title = form.id ? "メンバー紹介を編集" : "メンバーを追加";

  return (
    <section className={styles.panel} aria-label={title}>
      <h2 className={styles.panelTitle}>{title}</h2>
      <div className={styles.formGrid}>
        <TextField
          id="spotlight-company"
          label="会社名"
          value={form.companyName}
          maxLength={30}
          onChange={(companyName) => onChange({ companyName })}
        />
        <TextField
          id="spotlight-person"
          label="お名前（サイネージでは「さん」を付けて出します）"
          value={form.personName}
          maxLength={20}
          onChange={(personName) => onChange({ personName })}
        />
        <TextField id="spotlight-role" label="肩書き（任意）" value={form.role} maxLength={30} onChange={(role) => onChange({ role })} />

        <div className={styles.field}>
          <p className={styles.label} id="spotlight-tags-label">
            {`タグ（任意。${SPOTLIGHT_TAGS_MAX} つまで、各 ${SPOTLIGHT_TAG_MAX} 文字まで）`}
          </p>
          <div className={styles.ruleFields} role="group" aria-labelledby="spotlight-tags-label">
            {form.tags.map((tag, i) => (
              <input
                key={i}
                className={styles.input}
                aria-label={`タグ ${i + 1}`}
                value={tag}
                maxLength={SPOTLIGHT_TAG_MAX}
                onChange={(e) => onChange({ tags: form.tags.map((t, j) => (j === i ? e.target.value : t)) })}
              />
            ))}
          </div>
        </div>

        <CountedTextarea
          id="spotlight-quote"
          label="ひとこと（任意。サイネージでは「」で囲んで出します）"
          value={form.quote}
          max={SPOTLIGHT_QUOTE_MAX}
          onChange={(quote) => onChange({ quote })}
        />
        <CountedTextarea
          id="spotlight-bio"
          label="紹介文（任意）"
          value={form.bio}
          max={SPOTLIGHT_BIO_MAX}
          onChange={(bio) => onChange({ bio })}
        />

        <div className={`${styles.field} ${styles.fieldFull}`}>
          <MediaUploadField
            label="写真（任意。縦長の写真がきれいに出ます）"
            hint={IMAGE_HINT}
            previewUrl={form.photoPreviewUrl}
            selectedId={form.photoMediaId}
            disabled={pending}
            onBusyChange={(photo) => setUploading((u) => ({ ...u, photo }))}
            onChange={(photoMediaId, photoPreviewUrl) => patchImage({ photoMediaId, photoPreviewUrl })}
          />
        </div>
        <div className={`${styles.field} ${styles.fieldFull}`}>
          <MediaUploadField
            label="会社のロゴ（任意）"
            hint={IMAGE_HINT}
            previewUrl={form.logoPreviewUrl}
            selectedId={form.logoMediaId}
            disabled={pending}
            onBusyChange={(logo) => setUploading((u) => ({ ...u, logo }))}
            onChange={(logoMediaId, logoPreviewUrl) => patchImage({ logoMediaId, logoPreviewUrl })}
          />
        </div>

        <div className={styles.field}>
          <span className={styles.label}>サイネージに出す</span>
          <button
            type="button"
            role="switch"
            aria-checked={form.enabled}
            aria-label="サイネージに出す"
            className={styles.toggle}
            disabled={pending}
            onClick={() => onChange({ enabled: !form.enabled })}
          >
            {form.enabled ? "ON" : "OFF"}
          </button>
          <p className={styles.hint}>OFF にすると、登録したままサイネージには出しません。</p>
        </div>
      </div>

      {error ? (
        <p className={styles.formError} role="alert">
          {error}
        </p>
      ) : null}

      <div className={styles.imageActions} style={{ marginTop: 20 }}>
        <button
          type="button"
          className={styles.primaryButton}
          disabled={busy || form.companyName.trim() === "" || form.personName.trim() === ""}
          onClick={onSave}
        >
          保存する
        </button>
        <button type="button" className={styles.secondaryButton} disabled={pending} onClick={onCancel}>
          キャンセル
        </button>
      </div>
    </section>
  );
}

function TextField({
  id,
  label,
  value,
  maxLength,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  maxLength: number;
  onChange: (value: string) => void;
}) {
  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <input id={id} className={styles.input} value={value} maxLength={maxLength} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

/** 文字数を右下に出す入力欄（お知らせの本文と同じ見た目）。上限を超えると数字を赤にする */
function CountedTextarea({
  id,
  label,
  value,
  max,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  max: number;
  onChange: (value: string) => void;
}) {
  const length = countChars(value);
  return (
    <div className={`${styles.field} ${styles.fieldFull}`}>
      <label className={styles.label} htmlFor={id}>
        {label}
      </label>
      <div className={styles.textareaWrap}>
        <textarea id={id} className={styles.textarea} value={value} onChange={(e) => onChange(e.target.value)} />
        <span className={`${styles.counter} ${length > max ? styles.counterOver : ""}`}>
          {length} / {max}
        </span>
      </div>
    </div>
  );
}
