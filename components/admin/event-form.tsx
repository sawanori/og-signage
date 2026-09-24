"use client";

/**
 * イベントの追加・編集フォーム（React Hook Form + lib/validators.ts の eventInputSchema）。
 *
 * - 必須はイベント名と開始日時だけ。
 * - 保存中・保存失敗を表示する。失敗しても入力はそのまま残す。
 * - 他の人が先に更新していたら（revision 不一致）入力を保ったまま知らせ、最新の版で保存し直せるようにする。
 * - 保存・削除のあとは一覧へ戻り、一覧で結果を知らせる。
 */
import { ChevronLeft, Trash2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type CSSProperties } from "react";
import { useForm, useWatch } from "react-hook-form";
import {
  createEventAction,
  deleteEventAction,
  getEventAction,
  updateEventAction,
} from "@/app/admin/_actions/events";
import type { EventInput } from "@/lib/validators";
import { EventDeleteDialog } from "./event-delete-dialog";
import {
  emptyFormValues,
  eventFormResolver,
  toFormValues,
  type EventFormSource,
  type EventFormValues,
} from "./event-form-model";
import { EventImageField } from "./event-image-field";
import { mediaThumbnailUrl, type EventCategoryOption } from "./event-types";
import styles from "./events.module.css";

export const CONFLICT_MESSAGE = "他の人が先に更新しました。内容を確認して保存し直してください";
const SAVE_FAILED = "保存できませんでした。通信の状態を確認して、もう一度お試しください";
const DELETE_FAILED = "削除できませんでした。通信の状態を確認して、もう一度お試しください";

type Banner = { kind: "error" | "conflict"; message: string };

export type EventFormProps =
  | { mode: "create"; now: number; categories: EventCategoryOption[] }
  | {
      mode: "edit";
      eventId: string;
      event: EventFormSource;
      revision: number;
      categories: EventCategoryOption[];
    };

export function EventForm(props: EventFormProps) {
  const router = useRouter();
  const editing = props.mode === "edit";
  const [revision, setRevision] = useState(editing ? props.revision : 0);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [uploading, setUploading] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [imageUrl, setImageUrl] = useState<string | null>(
    editing && props.event.imageMediaId ? mediaThumbnailUrl(props.event.imageMediaId) : null,
  );

  const {
    register,
    handleSubmit,
    reset,
    setValue,
    control,
    formState: { errors, isSubmitting },
  } = useForm<EventFormValues, unknown, EventInput>({
    resolver: eventFormResolver,
    defaultValues: editing ? toFormValues(props.event) : emptyFormValues(props.now),
  });

  const participation = useWatch({ control, name: "participation" });
  const categoryId = useWatch({ control, name: "categoryId" });
  const status = useWatch({ control, name: "status" });

  const onSubmit = async (data: EventInput) => {
    setBanner(null);
    try {
      if (props.mode === "create") {
        const result = await createEventAction(data);
        if (!result.ok) return setBanner({ kind: "error", message: result.error.message });
        router.push("/admin/events?saved=created");
        return;
      }
      const result = await updateEventAction(props.eventId, { ...data, revision });
      if (result.ok) {
        router.push("/admin/events?saved=updated");
        return;
      }
      if (result.error.code === "conflict") {
        // 入力は保ったまま、次の保存が最新の版に対して行われるようにする
        const latest = await getEventAction(props.eventId);
        if (latest.ok) setRevision(latest.data.revision);
        setBanner({ kind: "conflict", message: CONFLICT_MESSAGE });
        return;
      }
      setBanner({ kind: "error", message: result.error.message });
    } catch {
      setBanner({ kind: "error", message: SAVE_FAILED });
    }
  };

  /** 競合のとき、入力を捨てて最新の内容を読み込む */
  const loadLatest = async () => {
    if (props.mode !== "edit") return;
    try {
      const latest = await getEventAction(props.eventId);
      if (!latest.ok) return setBanner({ kind: "error", message: latest.error.message });
      reset(toFormValues(latest.data));
      setRevision(latest.data.revision);
      setImageUrl(latest.data.imageMediaId ? mediaThumbnailUrl(latest.data.imageMediaId) : null);
      setBanner(null);
    } catch {
      setBanner({ kind: "error", message: "最新の内容を読み込めませんでした。もう一度お試しください" });
    }
  };

  const remove = async () => {
    if (props.mode !== "edit") return;
    setDeleting(true);
    try {
      const result = await deleteEventAction(props.eventId);
      if (result.ok) {
        router.push("/admin/events?saved=deleted");
        return;
      }
      setBanner({ kind: "error", message: result.error.message });
    } catch {
      setBanner({ kind: "error", message: DELETE_FAILED });
    }
    setDeleting(false);
    setConfirmDelete(false);
  };

  const fieldError = (name: keyof EventFormValues) =>
    errors[name]?.message ? (
      <p className={styles.fieldError} role="alert" id={`${name}-error`}>
        {errors[name]?.message}
      </p>
    ) : null;

  const invalid = (name: keyof EventFormValues) =>
    errors[name] ? { "aria-invalid": true, "aria-describedby": `${name}-error` } : {};

  const busy = isSubmitting || uploading || deleting;

  return (
    <div className={styles.page}>
      <div className={styles.pageHead}>
        <Link href="/admin/events" className={styles.backLink}>
          <ChevronLeft size={18} strokeWidth={2.4} aria-hidden />
          イベント一覧
        </Link>
        <h2 className={styles.pageTitle}>{editing ? "イベントを編集" : "新しいイベント"}</h2>
      </div>

      <form className={styles.formGrid} onSubmit={handleSubmit(onSubmit)} noValidate aria-label="イベントの内容">
        <div className={styles.formMain}>
          <section className={styles.card} aria-labelledby="basic-title">
            <h3 id="basic-title" className={styles.cardTitle}>
              基本の情報
            </h3>

            <div className={styles.field}>
              <label htmlFor="title" className={styles.label}>
                イベント名<span className={styles.required}>必須</span>
              </label>
              <input id="title" className={styles.input} placeholder="例: Pizza Night" {...register("title")} {...invalid("title")} />
              {fieldError("title")}
            </div>

            <div className={`${styles.fieldRow} ${styles.dateRow}`}>
              <div className={styles.field}>
                <label htmlFor="startDate" className={styles.label}>
                  開始日時<span className={styles.required}>必須</span>
                </label>
                <div className={styles.dateTime}>
                  <input id="startDate" type="date" className={styles.input} {...register("startDate")} {...invalid("startDate")} />
                  <input
                    type="time"
                    className={styles.input}
                    aria-label="開始の時刻"
                    {...register("startTime")}
                    {...invalid("startDate")}
                  />
                </div>
                {fieldError("startDate")}
              </div>

              <div className={styles.field}>
                <label htmlFor="endTime" className={styles.label}>
                  終了日時<span className={styles.optional}>任意</span>
                </label>
                <div className={styles.dateTime}>
                  <input type="date" className={styles.input} aria-label="終了の日付" {...register("endDate")} {...invalid("endTime")} />
                  <input id="endTime" type="time" className={styles.input} {...register("endTime")} {...invalid("endTime")} />
                </div>
                <p className={styles.hint}>未入力の場合はその日の終わりまで表示されます。日付を空けると開始と同じ日になります。</p>
                {fieldError("endTime")}
              </div>
            </div>

            <div className={styles.field}>
              <label htmlFor="location" className={styles.label}>
                場所
              </label>
              <input id="location" className={styles.input} placeholder="例: 2F ラウンジ" {...register("location")} {...invalid("location")} />
              {fieldError("location")}
            </div>

            <div className={styles.field}>
              <label htmlFor="description" className={styles.label}>
                説明
              </label>
              <textarea
                id="description"
                rows={4}
                className={`${styles.input} ${styles.textarea}`}
                placeholder="例: みんなでピザを食べながらゆるく交流しましょう！"
                {...register("description")}
                {...invalid("description")}
              />
              {fieldError("description")}
            </div>
          </section>

          <section className={styles.card} aria-labelledby="look-title">
            <h3 id="look-title" className={styles.cardTitle}>
              サイネージでの見せ方
            </h3>

            <fieldset className={styles.field}>
              <legend className={styles.label}>カテゴリ</legend>
              <div className={styles.categoryChips}>
                <label className={styles.categoryChip} data-selected={categoryId === ""}>
                  <input type="radio" value="" {...register("categoryId")} />
                  なし
                </label>
                {props.categories.map((c) => (
                  <label
                    key={c.id}
                    className={styles.categoryChip}
                    data-selected={categoryId === c.id}
                    style={{ "--chip-color": c.color } as CSSProperties}
                  >
                    <input type="radio" value={c.id} {...register("categoryId")} />
                    <span className={styles.categoryDot} aria-hidden />
                    {c.name}
                  </label>
                ))}
              </div>
              {fieldError("categoryId")}
            </fieldset>

            <div className={styles.fieldRow}>
              <div className={styles.field}>
                <label htmlFor="emoji" className={styles.label}>
                  絵文字
                </label>
                <input id="emoji" className={`${styles.input} ${styles.emojiInput}`} {...register("emoji")} {...invalid("emoji")} />
                <p className={styles.hint}>1 つだけ入力します（例: 🍕）。イベント名の横に表示されます。</p>
                {fieldError("emoji")}
              </div>
              <div className={styles.field}>
                <label htmlFor="hostName" className={styles.label}>
                  主催者
                </label>
                <input id="hostName" className={styles.input} placeholder="例: Yuki" {...register("hostName")} {...invalid("hostName")} />
                {fieldError("hostName")}
              </div>
            </div>

            <div className={styles.field}>
              <label htmlFor="catchCopy" className={styles.label}>
                キャッチコピー
              </label>
              <input
                id="catchCopy"
                className={styles.input}
                placeholder="例: Good Food / Good People!"
                {...register("catchCopy")}
                {...invalid("catchCopy")}
              />
              <p className={styles.hint}>写真の上に手書き風の文字で表示されます。</p>
              {fieldError("catchCopy")}
            </div>
          </section>

          <section className={styles.card} aria-labelledby="join-title">
            <h3 id="join-title" className={styles.cardTitle}>
              参加のしかた
            </h3>

            <fieldset className={styles.field}>
              <legend className={styles.label}>参加形態</legend>
              <div className={styles.segment}>
                <label className={styles.segmentItem} data-selected={participation === "free"}>
                  <input type="radio" value="free" {...register("participation")} />
                  参加自由・予約不要
                </label>
                <label className={styles.segmentItem} data-selected={participation === "limited"}>
                  <input type="radio" value="limited" {...register("participation")} />
                  定員あり
                </label>
              </div>
            </fieldset>

            <div className={styles.fieldRow}>
              {participation === "limited" ? (
                <div className={styles.field}>
                  <label htmlFor="capacity" className={styles.label}>
                    定員<span className={styles.required}>必須</span>
                  </label>
                  <div className={styles.withUnit}>
                    <input
                      id="capacity"
                      type="number"
                      min={1}
                      step={1}
                      inputMode="numeric"
                      className={`${styles.input} ${styles.numberInput}`}
                      {...register("capacity")}
                      {...invalid("capacity")}
                    />
                    <span>人</span>
                  </div>
                  {fieldError("capacity")}
                </div>
              ) : null}
              <div className={styles.field}>
                <label htmlFor="participantCount" className={styles.label}>
                  参加人数
                </label>
                <div className={styles.withUnit}>
                  <input
                    id="participantCount"
                    type="number"
                    min={0}
                    step={1}
                    inputMode="numeric"
                    className={`${styles.input} ${styles.numberInput}`}
                    {...register("participantCount")}
                    {...invalid("participantCount")}
                  />
                  <span>人</span>
                </div>
                <p className={styles.hint}>受付で数えた人数を入力します。</p>
                {fieldError("participantCount")}
              </div>
            </div>

            <div className={styles.field}>
              <label htmlFor="qrUrl" className={styles.label}>
                詳細・申し込みページの URL
              </label>
              <input
                id="qrUrl"
                type="url"
                className={styles.input}
                placeholder="https://..."
                {...register("qrUrl")}
                {...invalid("qrUrl")}
              />
              <p className={styles.hint}>サイネージに QR コードで表示されます。</p>
              {fieldError("qrUrl")}
            </div>
          </section>
        </div>

        <aside className={styles.formSide}>
          <section className={styles.card} aria-labelledby="image-title">
            <h3 id="image-title" className={styles.cardTitle}>
              イベント画像
            </h3>
            <EventImageField
              previewUrl={imageUrl}
              onBusyChange={setUploading}
              onUploaded={(mediaId, url) => {
                setValue("imageMediaId", mediaId, { shouldDirty: true });
                setImageUrl(url);
              }}
              onRemove={() => {
                setValue("imageMediaId", "", { shouldDirty: true });
                setImageUrl(null);
              }}
            />
            {fieldError("imageMediaId")}
          </section>

          <section className={`${styles.card} ${styles.publishCard}`} aria-labelledby="publish-title">
            <h3 id="publish-title" className={styles.cardTitle}>
              公開
            </h3>
            <div className={styles.segment}>
              <label className={styles.segmentItem} data-selected={status === "published"}>
                <input type="radio" value="published" {...register("status")} />
                公開する
              </label>
              <label className={styles.segmentItem} data-selected={status === "draft"}>
                <input type="radio" value="draft" {...register("status")} />
                下書き
              </label>
            </div>
            <p className={styles.hint}>下書きはサイネージに表示されません。</p>

            {banner ? (
              <div className={banner.kind === "conflict" ? styles.bannerWarn : styles.bannerError} role="alert">
                <p>{banner.message}</p>
                {banner.kind === "conflict" ? (
                  <button type="button" className={styles.textButton} onClick={loadLatest} disabled={busy}>
                    入力を捨てて最新の内容を表示する
                  </button>
                ) : null}
              </div>
            ) : null}
            {Object.keys(errors).length > 0 ? (
              <p className={styles.bannerError} role="status">
                入力内容を確認してください
              </p>
            ) : null}

            <button type="submit" className={styles.primaryButton} disabled={busy}>
              {isSubmitting ? "保存しています…" : uploading ? "画像をアップロード中…" : "保存する"}
            </button>
            {editing ? (
              <button type="button" className={styles.deleteButton} disabled={busy} onClick={() => setConfirmDelete(true)}>
                <Trash2 size={16} strokeWidth={2} aria-hidden />
                このイベントを削除する
              </button>
            ) : null}
          </section>
        </aside>
      </form>

      {confirmDelete ? (
        <EventDeleteDialog
          title={editing ? props.event.title : ""}
          pending={deleting}
          onConfirm={remove}
          onCancel={() => setConfirmDelete(false)}
        />
      ) : null}
    </div>
  );
}
