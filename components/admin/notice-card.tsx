"use client";

/**
 * お知らせ表示。更新が新しいお知らせ 1 件の ON/OFF・本文（100 文字まで）・表示時間帯をその場で保存する。
 * 本文は入力欄から離れたとき、ON/OFF と時間帯は変えたときに保存する。
 */
import { CircleHelp } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { updateNoticeAction } from "@/app/admin/_actions/content";
import { NOTICE_BODY_MAX, countChars } from "@/lib/validators";
import styles from "./admin.module.css";
import type { DashboardNotice } from "./dashboard-types";

const HELP = "「時間帯を指定」を選ぶと、その時間だけサイネージにお知らせを出します。日をまたぐ時間帯も指定できます。";

export function NoticeCard({ notice }: { notice: DashboardNotice | null }) {
  return (
    <section className={`${styles.card} ${styles.noticeCard}`} aria-label="お知らせ表示">
      {notice ? (
        <NoticeForm notice={notice} />
      ) : (
        <>
          <div className={styles.cardHeadRow}>
            <h2 className={styles.cardTitleSmall}>お知らせ表示</h2>
          </div>
          <div className={`${styles.empty} ${styles.cardEmptyBody}`}>
            <p>お知らせはまだありません。</p>
            <Link href="/admin/notices" className={styles.emptyLink}>
              お知らせを作成
            </Link>
          </div>
        </>
      )}
    </section>
  );
}

function NoticeForm({ notice }: { notice: DashboardNotice }) {
  const [saved, setSaved] = useState(notice);
  const [body, setBody] = useState(notice.body ?? "");
  const [mode, setMode] = useState(notice.displayMode);
  const [start, setStart] = useState(notice.displayStartTime ?? "");
  const [end, setEnd] = useState(notice.displayEndTime ?? "");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();
  const length = countChars(body);

  const save = (patch: Partial<DashboardNotice>) => {
    const next: DashboardNotice = {
      ...saved,
      body: body.trim() === "" ? null : body,
      displayMode: mode,
      displayStartTime: mode === "timeRange" && start ? start : null,
      displayEndTime: mode === "timeRange" && end ? end : null,
      ...patch,
    };
    // 時間帯の指定は開始と終了の両方がそろってから保存する
    if (next.displayMode === "timeRange" && (!next.displayStartTime || !next.displayEndTime)) return;
    if (countChars(next.body ?? "") > NOTICE_BODY_MAX) {
      setError(`本文は${NOTICE_BODY_MAX}文字以内で入力してください`);
      return;
    }
    startTransition(async () => {
      const result = await updateNoticeAction(next.id, {
        title: next.title,
        body: next.body,
        imageMediaId: next.imageMediaId,
        enabled: next.enabled,
        displayMode: next.displayMode,
        displayStartTime: next.displayStartTime,
        displayEndTime: next.displayEndTime,
        revision: next.revision,
      });
      if (result.data) {
        setError(null);
        setSaved({ ...next, revision: result.data.revision });
      } else {
        setError(result.error.message);
        if (result.error.code === "conflict") router.refresh();
      }
    });
  };

  return (
    <>
      <div className={styles.cardHeadRow}>
        <h2 className={styles.cardTitleSmall}>お知らせ表示</h2>
        <button
          type="button"
          role="switch"
          aria-checked={saved.enabled}
          aria-label="お知らせ表示"
          className={`${styles.toggle} ${styles.toggleSmall}`}
          disabled={pending}
          onClick={() => save({ enabled: !saved.enabled })}
        >
          {saved.enabled ? "ON" : "OFF"}
        </button>
      </div>
      <p className={styles.noticeSub}>イベントがない時間にお知らせを表示できます。</p>
      <label className={styles.noticeLabel} htmlFor="dashboard-notice-body">
        お知らせ内容
      </label>
      <div className={styles.textareaWrap}>
        <textarea
          id="dashboard-notice-body"
          className={styles.textarea}
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onBlur={() => {
            if (body !== (saved.body ?? "")) save({});
          }}
        />
        <span className={`${styles.counter} ${length > NOTICE_BODY_MAX ? styles.counterOver : ""}`}>
          {length} / {NOTICE_BODY_MAX}
        </span>
      </div>
      <label className={styles.noticeLabel} htmlFor="dashboard-notice-mode" style={{ marginTop: 9 }}>
        表示する時間帯
      </label>
      <div className={styles.noticeTimeRow}>
        <select
          id="dashboard-notice-mode"
          className={`${styles.select} ${styles.noticeSelect}`}
          value={mode}
          disabled={pending}
          onChange={(e) => {
            const value = e.target.value as DashboardNotice["displayMode"];
            setMode(value);
            if (value === "always") save({ displayMode: "always", displayStartTime: null, displayEndTime: null });
          }}
        >
          <option value="always">常に表示</option>
          <option value="timeRange">時間帯を指定</option>
        </select>
        {mode === "timeRange" ? (
          <>
            <input
              type="time"
              className={styles.timeInput}
              aria-label="表示の開始時刻"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              onBlur={() => save({})}
            />
            <input
              type="time"
              className={styles.timeInput}
              aria-label="表示の終了時刻"
              value={end}
              onChange={(e) => setEnd(e.target.value)}
              onBlur={() => save({})}
            />
          </>
        ) : null}
        <span title={HELP} aria-label={HELP} role="img" style={{ display: "inline-flex" }}>
          <CircleHelp className={`${styles.helpIcon} ${styles.noticeHelp}`} strokeWidth={2} aria-hidden />
        </span>
      </div>
      {error ? (
        <p className={styles.cardError} role="alert">
          {error}
        </p>
      ) : null}
    </>
  );
}
