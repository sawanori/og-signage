"use client";

import "@fontsource/line-seed-jp/400.css";
import "@fontsource/line-seed-jp/700.css";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { prepareSpotlightImage } from "@/lib/client/prepare-spotlight-image";
import { submitSpotlight, type SpotlightSubmissionSnapshot } from "@/lib/client/submit-spotlight";
import { spotlightSubmissionInputSchema, type SpotlightSubmissionImageKind } from "@/lib/spotlight-submissions";
import { countChars, SPOTLIGHT_BIO_MAX, SPOTLIGHT_QUOTE_MAX, SPOTLIGHT_TAG_MAX, SPOTLIGHT_TAGS_MAX } from "@/lib/validators";
import { SpotlightPreview } from "./spotlight-preview";
import styles from "./registration.module.css";

type TextFields = { companyName: string; personName: string; email: string; personNameKana: string; role: string; quote: string; bio: string };
type ImageSelection = { blob: Blob; url: string };
type Images = Record<SpotlightSubmissionImageKind, ImageSelection | null>;
type Phase = "editing" | "sending" | "uncertain" | "accepted";
const EMPTY_TEXT: TextFields = { companyName: "", personName: "", email: "", personNameKana: "", role: "", quote: "", bio: "" };
const EMPTY_IMAGES: Images = { photo: null, logo: null };
const optional = (text: string) => text.trim() || null;

/** notificationFrom: 結果メールの差出人（例「サイネージ管理 <noreply@non-turn.com>」）。完了画面で迷惑メールの確認を案内する */
export function SpotlightRegistrationForm({ notificationFrom }: { notificationFrom: string }) {
  const [fields, setFields] = useState(EMPTY_TEXT);
  const [tags, setTags] = useState<string[]>(Array.from({ length: SPOTLIGHT_TAGS_MAX }, () => ""));
  const [consent, setConsent] = useState(false);
  const [images, setImages] = useState<Images>(EMPTY_IMAGES);
  const [preparing, setPreparing] = useState<SpotlightSubmissionImageKind | null>(null);
  const [phase, setPhase] = useState<Phase>("editing");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [retryAfterSeconds, setRetryAfterSeconds] = useState(0);
  const snapshot = useRef<SpotlightSubmissionSnapshot | null>(null);
  const unresolved = useRef(false);
  const sending = useRef(false);
  const imageRefs = useRef<Images>(EMPTY_IMAGES);
  const active = useRef(true);
  const locked = phase === "sending" || phase === "uncertain";

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      for (const image of Object.values(imageRefs.current)) if (image) URL.revokeObjectURL(image.url);
    };
  }, []);

  useEffect(() => {
    if (retryAfterSeconds <= 0) return;
    const timer = setTimeout(() => setRetryAfterSeconds((seconds) => seconds - 1), 1000);
    return () => clearTimeout(timer);
  }, [retryAfterSeconds]);

  const textPayload = {
    companyName: fields.companyName.trim(), personName: fields.personName.trim(),
    personNameKana: optional(fields.personNameKana), role: optional(fields.role),
    quote: optional(fields.quote), bio: optional(fields.bio), tags: tags.map((tag) => tag.trim()).filter(Boolean),
  };

  const change = (key: keyof TextFields, value: string) => {
    if (locked) return;
    setFields((current) => ({ ...current, [key]: value }));
    setErrors((current) => ({ ...current, [key]: "" }));
  };

  const replaceImage = (kind: SpotlightSubmissionImageKind, next: ImageSelection | null) => {
    const previous = imageRefs.current[kind];
    if (previous) URL.revokeObjectURL(previous.url);
    imageRefs.current = { ...imageRefs.current, [kind]: next };
    setImages(imageRefs.current);
  };

  const chooseImage = async (kind: SpotlightSubmissionImageKind, file: File | undefined) => {
    if (!file || locked || preparing) return;
    setPreparing(kind);
    setErrors((current) => ({ ...current, [kind]: "" }));
    try {
      const result = await prepareSpotlightImage(file, kind);
      if (active.current) replaceImage(kind, { blob: result.blob, url: URL.createObjectURL(result.blob) });
    } catch (error) {
      if (active.current) setErrors((current) => ({ ...current, [kind]: error instanceof Error ? error.message : "画像を処理できませんでした。" }));
    } finally {
      if (active.current) setPreparing(null);
    }
  };

  const send = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (sending.current || preparing || retryAfterSeconds > 0 || phase === "accepted") return;
    let current = snapshot.current;
    if (!current) {
      const parsed = spotlightSubmissionInputSchema.safeParse({ ...textPayload, email: fields.email, requestKey: crypto.randomUUID(), consent });
      if (!parsed.success) {
        const next: Record<string, string> = {};
        for (const issue of parsed.error.issues) {
          const key = String(issue.path[0] ?? "form");
          next[key] ??= issue.message;
        }
        setErrors(next);
        setMessage("入力内容を確認してください。");
        return;
      }
      current = { data: parsed.data, photo: images.photo?.blob ?? null, logo: images.logo?.blob ?? null };
      snapshot.current = current;
    }
    sending.current = true;
    setPhase("sending");
    setMessage(null);
    const result = await submitSpotlight(current);
    sending.current = false;
    if (!active.current) return;
    if (result.kind === "accepted") {
      unresolved.current = false;
      snapshot.current = null;
      setPhase("accepted");
      replaceImage("photo", null);
      replaceImage("logo", null);
      return;
    }
    setMessage(result.message);
    if (result.kind === "expired") {
      unresolved.current = false;
      snapshot.current = null;
      setPhase("editing");
      return;
    }
    if (result.kind === "uncertain") unresolved.current = true;
    if (result.kind === "rejected") setRetryAfterSeconds(result.retryAfterSeconds);
    if (unresolved.current) {
      setPhase("uncertain");
    } else {
      snapshot.current = null;
      setPhase("editing");
    }
  };

  if (phase === "accepted") {
    // 「名前 <アドレス>」は名前とアドレスの間でだけ改行し、アドレスの途中（non- の後など）では切らない
    const sender = /^(.*\S)\s+(<[^>]+>)$/.exec(notificationFrom);
    return (
      <main className={styles.page}>
        <section className={`${styles.card} ${styles.complete}`}>
          <span className={styles.eyebrow}>MEMBER SPOTLIGHT</span>
          <div className={styles.completeMark} aria-hidden>✓</div>
          <h1>送信しました</h1>
          <p>スタッフの確認後に掲載されます。</p>
          <p>掲載の可否は、ご入力のメールアドレスへお知らせします。</p>
          <p className={styles.hint}>お知らせは「{sender ? <>{sender[1]} <span style={{ whiteSpace: "nowrap" }}>{sender[2]}</span></> : notificationFrom}」から届きます。見当たらないときは、迷惑メールフォルダーもご確認ください。</p>
          <p className={styles.hint}>修正が必要な場合はスタッフへご依頼ください。<br />この画面は閉じていただけます。</p>
        </section>
      </main>
    );
  }

  const imageField = (kind: SpotlightSubmissionImageKind) => {
    const label = kind === "photo" ? "写真" : "会社のロゴ";
    const image = images[kind];
    return (
      <div className={styles.field}>
        <label htmlFor={`member-${kind}`}>{label}（任意）</label>
        <p className={styles.hint}>{kind === "photo" ? "縦長のお写真がおすすめです。" : "背景が透明な画像も使えます。"}JPEG・PNG・WebP、元画像20MBまで。</p>
        <input id={`member-${kind}`} type="file" accept="image/jpeg,image/png,image/webp" disabled={locked || preparing !== null} aria-invalid={Boolean(errors[kind])} aria-describedby={errors[kind] ? `${kind}-error` : undefined}
          onChange={(event) => { void chooseImage(kind, event.currentTarget.files?.[0]); event.currentTarget.value = ""; }} />
        {preparing === kind ? <p role="status">画像を準備しています…</p> : null}
        {image ? <div className={styles.selectedImage}>
          {/* eslint-disable-next-line @next/next/no-img-element -- アップロード前のローカルBlob */}
          <img src={image.url} alt={`選択した${label}`} />
          <button type="button" className={styles.textButton} disabled={locked || preparing !== null} onClick={() => { if (!locked) replaceImage(kind, null); }}>{label}を取り消す</button>
        </div> : null}
        {errors[kind] ? <p id={`${kind}-error`} className={styles.fieldError}>{errors[kind]}</p> : null}
      </div>
    );
  };

  return (
    <main className={styles.page}>
      <div className={styles.container}>
        <header className={styles.header}>
          <span className={styles.eyebrow}>MEMBER SPOTLIGHT</span>
          <h1>メンバー紹介を登録</h1>
          <p>あなたのことを、みんなに紹介しませんか。</p>
          <p className={styles.hint}>スタッフの確認後、館内サイネージとログイン不要のWebサイネージに掲載されます。</p>
        </header>
        <form className={styles.card} noValidate onSubmit={(event) => { void send(event); }}>
          <div className={styles.sectionHead}><h2>あなたについて</h2><p>会社名・所属とお名前をご入力ください。</p></div>
          <TextField name="companyName" label="会社名・所属" value={fields.companyName} max={30} required disabled={locked} error={errors.companyName} onChange={change} />
          <TextField name="personName" label="お名前" value={fields.personName} max={20} required disabled={locked} error={errors.personName} onChange={change} />
          <div className={styles.field}>
            <div className={styles.labelRow}><label htmlFor="member-email">メールアドレス</label><span className={styles.required}>必須</span></div>
            <p id="email-hint" className={styles.hint}>掲載の可否をお知らせします。サイネージには表示しません。</p>
            <input id="member-email" type="email" autoComplete="email" required value={fields.email} disabled={locked}
              aria-invalid={Boolean(errors.email)} aria-describedby={`email-hint${errors.email ? " email-error" : ""}`}
              onChange={(event) => change("email", event.target.value)} />
            {errors.email ? <p id="email-error" className={styles.fieldError}>{errors.email}</p> : null}
          </div>
          <TextField name="personNameKana" label="ふりがな（任意）" value={fields.personNameKana} max={40} disabled={locked} error={errors.personNameKana} onChange={change} />
          <TextField name="role" label="肩書き（任意）" value={fields.role} max={30} disabled={locked} error={errors.role} onChange={change} />
          <TextField name="quote" label="ひとこと（任意）" value={fields.quote} max={SPOTLIGHT_QUOTE_MAX} multiline disabled={locked} error={errors.quote} onChange={change} />
          {imageField("photo")}
          <details className={styles.details}>
            <summary>詳しい情報を追加する（任意）</summary>
            <TextField name="bio" label="紹介文（任意）" value={fields.bio} max={SPOTLIGHT_BIO_MAX} multiline disabled={locked} error={errors.bio} onChange={change} />
            <fieldset className={styles.tags} disabled={locked}>
              <legend>タグ（任意・{SPOTLIGHT_TAGS_MAX}つまで）</legend>
              <p className={styles.hint}>得意なことや興味のあることを、各{SPOTLIGHT_TAG_MAX}文字まで。</p>
              {tags.map((tag, index) => <input key={index} aria-label={`タグ ${index + 1}`} value={tag} aria-invalid={Boolean(errors.tags)} onChange={(event) => {
                if (!locked) setTags((current) => current.map((value, position) => position === index ? event.target.value : value));
              }} />)}
              {errors.tags ? <p className={styles.fieldError}>{errors.tags}</p> : null}
            </fieldset>
            {imageField("logo")}
          </details>
          <div className={styles.review}>
            <button type="button" className={styles.secondaryButton} onClick={() => setShowPreview((value) => !value)}>{showPreview ? "掲載イメージを閉じる" : "掲載イメージを確認"}</button>
            {showPreview ? <div className={styles.previewArea}><SpotlightPreview payload={textPayload} photoUrl={images.photo?.url ?? null} logoUrl={images.logo?.url ?? null} /><p className={styles.hint}>横型サイネージでの掲載イメージです。</p></div> : null}
            <label className={styles.consent}>
              <input type="checkbox" checked={consent} disabled={locked} onChange={(event) => { if (!locked) setConsent(event.target.checked); }} aria-invalid={Boolean(errors.consent)} />
              <span>入力した紹介内容と写真を、館内および誰でも閲覧できるWebサイネージに掲載することに同意します。メールアドレスは掲載結果のお知らせに使い、掲載中は管理のために保管します。サイネージには表示しません。</span>
            </label>
            {errors.consent ? <p className={styles.fieldError}>{errors.consent}</p> : null}
            {message ? <p role="alert" className={styles.message}>{message}</p> : null}
            {phase === "uncertain" ? <p className={styles.hint}>重複を防ぐため、入力内容を固定しています。画面を閉じずに、同じ内容で送信結果を確認してください。</p> : null}
            {retryAfterSeconds > 0 ? <p role="status" className={styles.hint}>あと{retryAfterSeconds}秒お待ちください。</p> : null}
            <button type="submit" className={styles.primaryButton} disabled={phase === "sending" || preparing !== null || retryAfterSeconds > 0}>
              {phase === "sending" ? "送信しています…" : phase === "uncertain" ? "送信結果を確認" : "紹介を送信"}
            </button>
            <p className={styles.hint}>送信後の修正はスタッフへご依頼ください。</p>
          </div>
        </form>
      </div>
    </main>
  );
}

function TextField({ name, label, value, max, required = false, multiline = false, disabled, error, onChange }: {
  name: keyof TextFields; label: string; value: string; max: number; required?: boolean; multiline?: boolean; disabled: boolean; error?: string;
  onChange: (key: keyof TextFields, value: string) => void;
}) {
  const props = {
    id: `member-${name}`, value, disabled, required, "aria-invalid": Boolean(error),
    "aria-describedby": `${name}-count${error ? ` ${name}-error` : ""}`,
    onChange: (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange(name, event.target.value),
  };
  return <div className={styles.field}>
    <div className={styles.labelRow}><label htmlFor={props.id}>{label}</label>{required ? <span className={styles.required}>必須</span> : null}</div>
    {multiline ? <textarea {...props} rows={3} /> : <input {...props} autoComplete={name === "personName" ? "name" : name === "companyName" ? "organization" : "off"} />}
    <span className={styles.count} id={`${name}-count`}>{countChars(value)} / {max}文字</span>
    {error ? <p id={`${name}-error`} className={styles.fieldError}>{error}</p> : null}
  </div>;
}
