"use client";

/**
 * お知らせ（Staff 以上）。一覧・追加・編集・削除。lib/display-rules.ts の isNoticeActive が
 * 表示可否を決めるので、有効かつ表示時間帯内のものが複数あれば更新が新しい 1 件だけがサイネージに出る。
 */
import { ImagePlus, Pencil, Plus, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createNoticeAction, deleteNoticeAction, updateNoticeAction } from "@/app/admin/_actions/content";
import type { NoticeRow } from "@/lib/services/notices";
import { NOTICE_BODY_MAX, countChars } from "@/lib/validators";
import { MediaUploadField, mediaThumbnailUrl } from "./media-upload-field";
import styles from "./settings.module.css";

const SAVED_MESSAGE = "保存しました。サイネージには 30 秒以内に反映されます。";

type FormState = {
  id: string | null;
  title: string;
  body: string;
  imageMediaId: string | null;
  imagePreviewUrl: string | null;
  /** カードの右に出す QR の飛び先（任意） */
  qrUrl: string;
  enabled: boolean;
  displayMode: "always" | "timeRange";
  displayStartTime: string;
  displayEndTime: string;
  revision: number;
};

function emptyForm(): FormState {
  return {
    id: null,
    title: "",
    body: "",
    imageMediaId: null,
    imagePreviewUrl: null,
    qrUrl: "",
    enabled: true,
    displayMode: "always",
    displayStartTime: "",
    displayEndTime: "",
    revision: 0,
  };
}

function toForm(n: NoticeRow): FormState {
  return {
    id: n.id,
    title: n.title,
    body: n.body ?? "",
    imageMediaId: n.imageMediaId,
    imagePreviewUrl: n.imageMediaId ? mediaThumbnailUrl(n.imageMediaId) : null,
    qrUrl: n.qrUrl ?? "",
    enabled: n.enabled,
    displayMode: n.displayMode,
    displayStartTime: n.displayStartTime ?? "",
    displayEndTime: n.displayEndTime ?? "",
    revision: n.revision,
  };
}

function scheduleText(n: Pick<NoticeRow, "displayMode" | "displayStartTime" | "displayEndTime">): string {
  if (n.displayMode === "always") return "常に表示";
  if (!n.displayStartTime || !n.displayEndTime) return "時間帯未設定";
  return `${n.displayStartTime} - ${n.displayEndTime}`;
}

export function NoticesView({ notices }: { notices: NoticeRow[] }) {
  const [form, setForm] = useState<FormState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const openNew = () => {
    setForm(emptyForm());
    setError(null);
    setSuccess(false);
  };
  const openEdit = (n: NoticeRow) => {
    setForm(toForm(n));
    setError(null);
    setSuccess(false);
  };
  const closeForm = () => {
    setForm(null);
    setError(null);
  };

  const save = () => {
    if (!form) return;
    const length = countChars(form.body);
    if (length > NOTICE_BODY_MAX) {
      setError(`本文は${NOTICE_BODY_MAX}文字以内で入力してください`);
      return;
    }
    const timeRange = form.displayMode === "timeRange";
    const input = {
      title: form.title,
      body: form.body.trim() === "" ? null : form.body,
      imageMediaId: form.imageMediaId,
      qrUrl: form.qrUrl.trim() === "" ? null : form.qrUrl.trim(),
      enabled: form.enabled,
      displayMode: form.displayMode,
      displayStartTime: timeRange && form.displayStartTime ? form.displayStartTime : null,
      displayEndTime: timeRange && form.displayEndTime ? form.displayEndTime : null,
    };
    startTransition(async () => {
      const result = form.id
        ? await updateNoticeAction(form.id, { ...input, revision: form.revision })
        : await createNoticeAction(input);
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

  const remove = (n: NoticeRow) => {
    if (!window.confirm(`「${n.title}」を削除します。よろしいですか？`)) return;
    startTransition(async () => {
      const result = await deleteNoticeAction(n.id);
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
          <h1 className={styles.pageTitle}>お知らせ</h1>
          <p className={styles.pageDesc}>
            イベントがない時間にサイネージの「重要連絡：全メンバーへのお知らせ」欄に表示します。有効なお知らせが複数あるときは、更新が新しいものだけが表示されます。
          </p>
        </div>
        {form ? null : (
          <button type="button" className={styles.primaryButton} onClick={openNew}>
            <Plus size={18} strokeWidth={2.4} aria-hidden />
            新しいお知らせ
          </button>
        )}
      </div>

      {form ? (
        <NoticeForm
          form={form}
          setForm={setForm}
          pending={pending}
          uploading={uploading}
          setUploading={setUploading}
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

      <section className={styles.panel} aria-label="お知らせ一覧">
        <h2 className={styles.panelTitle}>お知らせ一覧</h2>
        {notices.length === 0 ? (
          <div className={styles.empty}>
            <p>お知らせはまだありません。</p>
          </div>
        ) : (
          <ul className={styles.list}>
            {notices.map((n) => (
              <li key={n.id} className={styles.listRow}>
                {n.imageMediaId ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img className={styles.thumb} src={mediaThumbnailUrl(n.imageMediaId)} alt="" />
                ) : (
                  <div className={`${styles.thumb} ${styles.thumbEmpty}`} aria-hidden>
                    <ImagePlus size={20} strokeWidth={1.6} />
                  </div>
                )}
                <div className={styles.rowMain}>
                  <p className={styles.rowTitle}>{n.title}</p>
                  {n.body ? <p className={styles.rowBody}>{n.body}</p> : null}
                </div>
                <span className={`${styles.badge} ${n.enabled ? styles.badgeOn : styles.badgeOff}`}>{n.enabled ? "ON" : "OFF"}</span>
                <p className={styles.scheduleText}>{scheduleText(n)}</p>
                <div className={styles.rowActions}>
                  <button type="button" className={styles.secondaryButton} disabled={pending} onClick={() => openEdit(n)}>
                    <Pencil size={14} strokeWidth={2.2} aria-hidden />
                    編集
                  </button>
                  <button
                    type="button"
                    className={`${styles.secondaryButton} ${styles.dangerButton}`}
                    disabled={pending}
                    onClick={() => remove(n)}
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

function NoticeForm({
  form,
  setForm,
  pending,
  uploading,
  setUploading,
  onSave,
  onCancel,
}: {
  form: FormState;
  setForm: (f: FormState) => void;
  pending: boolean;
  uploading: boolean;
  setUploading: (v: boolean) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const length = countChars(form.body);
  const busy = pending || uploading;

  return (
    <section className={styles.panel} aria-label={form.id ? "お知らせを編集" : "お知らせを追加"}>
      <h2 className={styles.panelTitle}>{form.id ? "お知らせを編集" : "新しいお知らせ"}</h2>
      <div className={styles.formGrid}>
        <div className={`${styles.field} ${styles.fieldFull}`}>
          <label className={styles.label} htmlFor="notice-title">
            見出し
          </label>
          <input
            id="notice-title"
            className={styles.input}
            value={form.title}
            maxLength={50}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
          />
        </div>

        <div className={`${styles.field} ${styles.fieldFull}`}>
          <label className={styles.label} htmlFor="notice-body">
            本文
          </label>
          <div className={styles.textareaWrap}>
            <textarea
              id="notice-body"
              className={styles.textarea}
              value={form.body}
              onChange={(e) => setForm({ ...form, body: e.target.value })}
            />
            <span className={`${styles.counter} ${length > NOTICE_BODY_MAX ? styles.counterOver : ""}`}>
              {length} / {NOTICE_BODY_MAX}
            </span>
          </div>
        </div>

        <div className={`${styles.field} ${styles.fieldFull}`}>
          <MediaUploadField
            label="画像（任意）"
            hint="JPEG・PNG・WebP（20MBまで）"
            previewUrl={form.imagePreviewUrl}
            selectedId={form.imageMediaId}
            disabled={pending}
            onBusyChange={setUploading}
            onChange={(mediaId, previewUrl) => setForm({ ...form, imageMediaId: mediaId, imagePreviewUrl: previewUrl })}
          />
        </div>

        <div className={`${styles.field} ${styles.fieldFull}`}>
          <label className={styles.label} htmlFor="notice-qr-url">
            QR コード（任意・飛び先の URL）
          </label>
          <input
            id="notice-qr-url"
            className={styles.input}
            type="url"
            value={form.qrUrl}
            maxLength={2000}
            placeholder="例：https://…（詳しい案内のページ）"
            disabled={pending}
            onChange={(e) => setForm({ ...form, qrUrl: e.target.value })}
          />
          <p className={styles.hint}>入れると、サイネージのお知らせの右に QR コードを出します。空欄なら出しません。</p>
        </div>

        <div className={styles.field}>
          <span className={styles.label}>表示</span>
          <button
            type="button"
            role="switch"
            aria-checked={form.enabled}
            aria-label="お知らせ表示"
            className={styles.toggle}
            disabled={pending}
            onClick={() => setForm({ ...form, enabled: !form.enabled })}
          >
            {form.enabled ? "ON" : "OFF"}
          </button>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="notice-mode">
            表示する時間帯
          </label>
          <select
            id="notice-mode"
            className={styles.select}
            value={form.displayMode}
            disabled={pending}
            onChange={(e) => setForm({ ...form, displayMode: e.target.value as FormState["displayMode"] })}
          >
            <option value="always">常に表示</option>
            <option value="timeRange">時間帯を指定</option>
          </select>
          {form.displayMode === "timeRange" ? (
            <div className={styles.timeGroup} style={{ marginLeft: 0, marginTop: 6 }}>
              <input
                type="time"
                className={styles.timeInput}
                aria-label="表示の開始時刻"
                value={form.displayStartTime}
                disabled={pending}
                onChange={(e) => setForm({ ...form, displayStartTime: e.target.value })}
              />
              <span className={styles.timeSep}>〜</span>
              <input
                type="time"
                className={styles.timeInput}
                aria-label="表示の終了時刻"
                value={form.displayEndTime}
                disabled={pending}
                onChange={(e) => setForm({ ...form, displayEndTime: e.target.value })}
              />
            </div>
          ) : null}
          <p className={styles.hint}>日をまたぐ時間帯（22:00〜翌6:00 など）も指定できます。</p>
        </div>
      </div>

      <div className={styles.imageActions} style={{ marginTop: 20 }}>
        <button type="button" className={styles.primaryButton} disabled={busy || form.title.trim() === ""} onClick={onSave}>
          保存する
        </button>
        <button type="button" className={styles.secondaryButton} disabled={pending} onClick={onCancel}>
          キャンセル
        </button>
      </div>
    </section>
  );
}
