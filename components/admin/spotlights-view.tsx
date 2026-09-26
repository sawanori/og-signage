"use client";

/**
 * メンバー紹介（Staff 以上）。一覧・追加・編集・削除。サイネージの MEMBER SPOTLIGHT には「サイネージに出す」が ON の人だけを、
 * 登録順に 1 人ずつ切り替えて出す（lib/config-builder.ts・lib/display-rules.ts）。
 * 一覧と保存の流れ（revision 競合のときは知らせて読み込み直す）はお知らせ（notices-view.tsx）にそろえる。
 */
import { Pencil, Plus, Trash2, UserRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createSpotlightAction, deleteSpotlightAction, updateSpotlightAction } from "@/app/admin/_actions/spotlights";
import type { SpotlightRow } from "@/lib/services/spotlights";
import { mediaThumbnailUrl } from "./media-upload-field";
import styles from "./settings.module.css";
import {
  SpotlightForm,
  emptySpotlightForm,
  spotlightFormError,
  toSpotlightForm,
  toSpotlightInput,
  type SpotlightFormState,
} from "./spotlight-form";

const SAVED_MESSAGE = "保存しました。サイネージには 30 秒以内に反映されます。";

export function SpotlightsView({ spotlights }: { spotlights: SpotlightRow[] }) {
  const [form, setForm] = useState<SpotlightFormState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const openNew = () => {
    setForm(emptySpotlightForm());
    setError(null);
    setSuccess(false);
  };
  const openEdit = (s: SpotlightRow) => {
    setForm(toSpotlightForm(s));
    setError(null);
    setSuccess(false);
  };
  const closeForm = () => {
    setForm(null);
    setError(null);
  };
  // 最新の入力に重ねる。閉じたあとに届いたアップロードの結果では入力欄を開き直さない
  const patchForm = (patch: Partial<SpotlightFormState>) => setForm((f) => (f ? { ...f, ...patch } : f));

  const save = () => {
    if (!form) return;
    const invalid = spotlightFormError(form);
    if (invalid) {
      setError(invalid);
      return;
    }
    const input = toSpotlightInput(form);
    startTransition(async () => {
      const result = form.id
        ? await updateSpotlightAction(form.id, { ...input, revision: form.revision })
        : await createSpotlightAction(input);
      if (result.error) {
        setError(result.error.message);
        if (result.error.code === "conflict") router.refresh();
        return;
      }
      setError(null);
      setSuccess(true);
      setForm(null);
      router.refresh();
    });
  };

  const remove = (s: SpotlightRow) => {
    if (!window.confirm(`「${s.personName}さん」を削除します。よろしいですか？`)) return;
    startTransition(async () => {
      const result = await deleteSpotlightAction(s.id);
      if (result.error) {
        setError(result.error.message);
        return;
      }
      setError(null);
      router.refresh();
    });
  };

  return (
    <div className={styles.page}>
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.pageTitle}>メンバー紹介</h1>
          <p className={styles.pageDesc}>サイネージの右上の MEMBER SPOTLIGHT に、登録順に 1 人ずつ切り替えて出します。</p>
        </div>
        {form ? null : (
          <button type="button" className={styles.primaryButton} onClick={openNew}>
            <Plus size={18} strokeWidth={2.4} aria-hidden />
            メンバーを追加
          </button>
        )}
      </div>

      {form ? (
        // 人ごとに作り直し、前の人の写真・ロゴのアップロード結果が入らないようにする（spotlight-form.tsx）
        <SpotlightForm
          key={form.id ?? "new"}
          form={form}
          onChange={patchForm}
          error={error}
          pending={pending}
          onSave={save}
          onCancel={closeForm}
        />
      ) : null}

      {error && !form ? (
        <p className={styles.formError} role="alert">
          {error}
        </p>
      ) : null}
      {success ? <p className={styles.formSuccess}>{SAVED_MESSAGE}</p> : null}

      <section className={styles.panel} aria-label="メンバー紹介一覧">
        <h2 className={styles.panelTitle}>メンバー紹介一覧</h2>
        {spotlights.length === 0 ? (
          <div className={styles.empty}>
            <p>メンバー紹介はまだありません。</p>
          </div>
        ) : (
          <ul className={styles.list}>
            {spotlights.map((s) => (
              <li key={s.id} className={styles.listRow}>
                {s.photoMediaId ? (
                  // 縦長の写真は顔が上の方にあるので、横長の枠では上寄りを見せる
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    className={styles.thumb}
                    style={{ objectPosition: "50% 20%" }}
                    src={mediaThumbnailUrl(s.photoMediaId)}
                    alt=""
                  />
                ) : (
                  <div className={`${styles.thumb} ${styles.thumbEmpty}`} aria-hidden>
                    <UserRound size={20} strokeWidth={1.6} />
                  </div>
                )}
                <div className={styles.rowMain}>
                  <p className={styles.rowTitle}>{s.personName}さん</p>
                  <p className={styles.rowBody}>{s.role ? `${s.companyName} / ${s.role}` : s.companyName}</p>
                </div>
                <span className={`${styles.badge} ${s.enabled ? styles.badgeOn : styles.badgeOff}`}>
                  {s.enabled ? "表示する" : "表示しない"}
                </span>
                <p className={styles.scheduleText}>{s.tags.join("・")}</p>
                <div className={styles.rowActions}>
                  <button type="button" className={styles.secondaryButton} disabled={pending} onClick={() => openEdit(s)}>
                    <Pencil size={14} strokeWidth={2.2} aria-hidden />
                    編集
                  </button>
                  <button
                    type="button"
                    className={`${styles.secondaryButton} ${styles.dangerButton}`}
                    disabled={pending}
                    onClick={() => remove(s)}
                  >
                    <Trash2 size={14} strokeWidth={2.2} aria-hidden />
                    削除
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
