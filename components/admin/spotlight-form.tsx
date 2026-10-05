"use client";

/**
 * メンバー紹介の入力欄（spotlights-view.tsx の「メンバーを追加」「編集」で開く）。
 * 見た目と操作はお知らせの入力欄（notices-view.tsx）にそろえ、写真・ロゴは画像欄の共通部品（MediaUploadField）を使う。
 * 文字数の上限は lib/validators.ts の spotlightInputSchema と同じ値。
 */
import { useEffect, useRef, useState } from "react";
import { fillEmptyFields, type BusinessCardField } from "@/lib/business-card";
import { useBusinessCardReader, type BusinessCardSide, type PickedCardImage } from "@/lib/client/use-business-card-reader";
import type { SpotlightRow } from "@/lib/services/spotlights";
import { SPOTLIGHT_BIO_MAX, SPOTLIGHT_FLOORS, SPOTLIGHT_PLACEHOLDER_EMAIL, SPOTLIGHT_QUOTE_MAX, SPOTLIGHT_TAG_MAX, SPOTLIGHT_TAGS_MAX, countChars, type SpotlightFloor } from "@/lib/validators";
import { MediaUploadField, mediaThumbnailUrl } from "./media-upload-field";
import styles from "./settings.module.css";

const IMAGE_HINT = "JPEG・PNG・WebP（20MBまで）";

type CardTextKey = "companyName" | "personName" | "personNameKana" | "role" | "contactEmail" | "websiteUrl";
/** 名刺の項目をどの入力欄に入れるか */
const CARD_FIELDS: Record<BusinessCardField, CardTextKey> = { companyName: "companyName", personName: "personName", personNameKana: "personNameKana", role: "role", email: "contactEmail", websiteUrl: "websiteUrl" };
const CARD_LABELS: Record<CardTextKey, string> = { companyName: "会社名", personName: "お名前", personNameKana: "ふりがな", role: "肩書き", contactEmail: "メールアドレス", websiteUrl: "ホームページの URL 1" };

export type SpotlightFormState = {
  id: string | null;
  companyName: string;
  personName: string;
  personNameKana: string;
  /** メールアドレス（必須。管理用でサイネージには出さない） */
  contactEmail: string;
  /** ホームページの URL（任意。サイネージのカードに QR で出す） */
  websiteUrl: string;
  websiteUrl2: string;
  role: string;
  quote: string;
  bio: string;
  /** タグの入力欄 3 つ分。空欄は送るときに除く */
  tags: string[];
  /** よくいる階（任意。選ばないときは null。サイネージのカードに小さなバッジで出す） */
  floor: SpotlightFloor | null;
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
    personNameKana: "",
    contactEmail: "",
    websiteUrl: "",
    websiteUrl2: "",
    role: "",
    quote: "",
    bio: "",
    tags: tagSlots([]),
    floor: null,
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
    personNameKana: s.personNameKana ?? "",
    contactEmail: s.contactEmail,
    websiteUrl: s.websiteUrl ?? "",
    websiteUrl2: s.websiteUrl2 ?? "",
    role: s.role ?? "",
    quote: s.quote ?? "",
    bio: s.bio ?? "",
    tags: tagSlots(s.tags),
    floor: toFloor(s.floor),
    photoMediaId: s.photoMediaId,
    photoPreviewUrl: s.photoMediaId ? mediaThumbnailUrl(s.photoMediaId) : null,
    logoMediaId: s.logoMediaId,
    logoPreviewUrl: s.logoMediaId ? mediaThumbnailUrl(s.logoMediaId) : null,
    enabled: s.enabled,
    revision: s.revision,
  };
}

const blankToNull = (value: string) => (value.trim() === "" ? null : value);
/** 選択肢にある階だけを通す（DB の整数や、選択欄の文字列から） */
const toFloor = (value: number | string | null | undefined): SpotlightFloor | null =>
  SPOTLIGHT_FLOORS.find((floor) => floor === Number(value)) ?? null;

/** Server Action に渡す形（revision は編集のときに呼び出し元が足す）。任意の文字は空欄なら null、空のタグ欄は除く */
export function toSpotlightInput(form: SpotlightFormState) {
  return {
    companyName: form.companyName,
    personName: form.personName,
    personNameKana: blankToNull(form.personNameKana),
    contactEmail: form.contactEmail,
    websiteUrl: blankToNull(form.websiteUrl.trim()),
    websiteUrl2: blankToNull(form.websiteUrl2.trim()),
    role: blankToNull(form.role),
    quote: blankToNull(form.quote),
    bio: blankToNull(form.bio),
    tags: form.tags.map((t) => t.trim()).filter((t) => t !== ""),
    floor: form.floor,
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
  // 名刺の読み取り中も保存しない（保存した後に読み取り結果が入ると、画面と保存した内容がずれる）
  // 名刺の読み取り（表は必須、裏は任意）。結果が届いた時点の入力を見て、空いている欄だけを埋める（編集中の値と既存の値は変えない）
  const formRef = useRef(form);
  useEffect(() => {
    formRef.current = form;
  }, [form]);
  const card = useBusinessCardReader((result) => {
    // 移行時に入れた仮のメールアドレスは、空欄と同じように名刺の値で埋める
    const { patch, filled } = fillEmptyFields(formRef.current, result, CARD_FIELDS, (key, value) =>
      value.trim() === "" || (key === "contactEmail" && value === SPOTLIGHT_PLACEHOLDER_EMAIL),
    );
    if (filled.length) onChange(patch);
    return filled.length
      ? `名刺から「${filled.map((key) => CARD_LABELS[key]).join("」「")}」を入力しました。内容を確認してから保存してください。`
      : "名刺から新しく入力できる項目はありませんでした（入力済みの欄はそのままです）。";
  });
  const busy = pending || uploading.photo || uploading.logo || card.busy;
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
        {/* 本人登録と同じく、スマホではすぐ背面カメラが開く「カメラで撮影」と、画像を選ぶボタンを分ける（2026-10-02 ユーザー指示） */}
        <div className={`${styles.field} ${styles.fieldFull}`} role="group" aria-labelledby="spotlight-card-title">
          <p className={styles.label} id="spotlight-card-title">
            名刺から入力（任意）
          </p>
          <p className={styles.hint}>
            表を撮影し、裏にも情報があれば裏も撮影してから「名刺を読み取る」を押してください。空いている欄（会社名・お名前・ふりがな・肩書き・メールアドレス・ホームページの URL 1）に入れます。明るい場所で、名刺全体が写るように撮ってください。
          </p>
          {(["front", "back"] as const).map((side) => (
            <CardSidePicker
              key={side}
              side={side}
              image={card.picked[side]}
              disabled={pending || card.busy}
              onPick={(file) => card.pick(side, file)}
              onClear={() => card.clear(side)}
            />
          ))}
          <div className={styles.imageActions}>
            <button type="button" className={styles.secondaryButton} disabled={pending || card.busy || !card.picked.front} onClick={() => void card.read()}>
              名刺を読み取る
            </button>
          </div>
          {card.busy ? (
            <p className={styles.hint} role="status">
              名刺を読み取っています…
            </p>
          ) : null}
          {card.message ? (
            <p className={styles.hint} role="status">
              {card.message}
            </p>
          ) : null}
          {card.error ? (
            <p className={styles.fieldError} role="alert">
              {card.error}
            </p>
          ) : null}
        </div>
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
        <div className={`${styles.field} ${styles.fieldFull}`}>
          <label className={styles.label} htmlFor="spotlight-email">
            メールアドレス（必須。管理用で、サイネージには表示しません）
          </label>
          <input
            id="spotlight-email"
            className={styles.input}
            type="email"
            autoComplete="off"
            value={form.contactEmail}
            maxLength={254}
            aria-describedby={form.contactEmail === SPOTLIGHT_PLACEHOLDER_EMAIL ? "spotlight-email-placeholder" : undefined}
            onChange={(e) => onChange({ contactEmail: e.target.value })}
          />
          {form.contactEmail === SPOTLIGHT_PLACEHOLDER_EMAIL ? (
            <p id="spotlight-email-placeholder" className={styles.hint}>
              仮のアドレスです（届きません）。分かれば本人のメールアドレスに直してください。
            </p>
          ) : null}
        </div>
        {/* 説明が長いので 1 行を使う（肩書きとタグは今までどおり横に並べる） */}
        <TextField
          id="spotlight-kana"
          label="ふりがな（任意。一覧の あ行・か行… の絞り込みと名前順に使います）"
          value={form.personNameKana}
          maxLength={40}
          full
          onChange={(personNameKana) => onChange({ personNameKana })}
        />
        <TextField id="spotlight-role" label="肩書き（任意）" value={form.role} maxLength={30} onChange={(role) => onChange({ role })} />
        <div className={styles.field}>
          <label className={styles.label} htmlFor="spotlight-floor">
            よくいる階（任意。サイネージに小さなバッジで出します）
          </label>
          <select
            id="spotlight-floor"
            className={styles.select}
            value={form.floor ?? ""}
            onChange={(e) => onChange({ floor: toFloor(e.target.value === "" ? null : e.target.value) })}
          >
            <option value="">選択しない</option>
            {SPOTLIGHT_FLOORS.map((floor) => (
              <option key={floor} value={floor}>
                {floor}階
              </option>
            ))}
          </select>
        </div>

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
          label="ひとこと（任意。サイネージでは写真の上に、手書き風の文字で出します）"
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
        {/* 会社のロゴはサイネージに出さないので欄を外した（2026-10-01 ユーザー指示）。登録済みのロゴは保存しても変えない */}
        <TextField
          id="spotlight-website"
          label="ホームページのURL 1（任意。サイネージのカードの右下にQRコードで出します）"
          value={form.websiteUrl}
          maxLength={200}
          full
          onChange={(websiteUrl) => onChange({ websiteUrl })}
        />
        <TextField
          id="spotlight-website-2"
          label="ホームページのURL 2（任意）"
          value={form.websiteUrl2}
          maxLength={200}
          full
          onChange={(websiteUrl2) => onChange({ websiteUrl2 })}
        />

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
          disabled={busy || form.companyName.trim() === "" || form.personName.trim() === "" || form.contactEmail.trim() === ""}
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

/** 名刺の片面。スマホではすぐ背面カメラが開く「カメラで撮影」と、撮影済みの画像を選ぶ「画像を選ぶ」 */
function CardSidePicker({
  side,
  image,
  disabled,
  onPick,
  onClear,
}: {
  side: BusinessCardSide;
  image: PickedCardImage | null;
  disabled: boolean;
  onPick: (file: File | undefined) => void;
  onClear: () => void;
}) {
  const camera = useRef<HTMLInputElement>(null);
  const library = useRef<HTMLInputElement>(null);
  const name = side === "front" ? "表" : "裏";
  return (
    <div className={styles.cardSide}>
      <p className={styles.cardSideLabel}>{side === "front" ? "表" : "裏（任意）"}</p>
      {image ? (
        <div className={styles.imageActions}>
          {/* eslint-disable-next-line @next/next/no-img-element -- 読み取り前のローカルBlob */}
          <img className={styles.cardThumb} src={image.url} alt={`選択した名刺の${name}`} />
          <button type="button" className={styles.textButton} disabled={disabled} onClick={onClear}>
            {name}を取り消す
          </button>
        </div>
      ) : (
        <div className={styles.imageActions}>
          <button type="button" className={styles.secondaryButton} disabled={disabled} onClick={() => camera.current?.click()}>
            カメラで撮影
          </button>
          <button type="button" className={styles.secondaryButton} disabled={disabled} onClick={() => library.current?.click()}>
            画像を選ぶ
          </button>
        </div>
      )}
      {(
        [
          { ref: camera, label: `名刺の${name}をカメラで撮影`, capture: "environment" as const },
          { ref: library, label: `名刺の${name}の画像を選ぶ`, capture: undefined },
        ] as const
      ).map(({ ref, label, capture }) => (
        <input
          key={label}
          ref={ref}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          capture={capture}
          hidden
          aria-label={label}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            onPick(file);
          }}
        />
      ))}
    </div>
  );
}

function TextField({
  id,
  label,
  value,
  maxLength,
  full = false,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  maxLength: number;
  /** 2 列の欄を 1 行使う */
  full?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className={full ? `${styles.field} ${styles.fieldFull}` : styles.field}>
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
