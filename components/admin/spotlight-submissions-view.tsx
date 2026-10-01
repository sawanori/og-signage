"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { approveSpotlightSubmissionAction, rejectSpotlightSubmissionAction } from "@/app/admin/_actions/spotlight-submissions";
import { SpotlightPreview } from "@/components/members/spotlight-preview";
import type { SpotlightNotificationStatus, SpotlightSubmissionDetail } from "@/lib/spotlight-submissions";
import { ConfirmDialog, type ConfirmRequest } from "./confirm-dialog";
import styles from "./settings.module.css";

const dateTime = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

function submissionKey(submission: SpotlightSubmissionDetail) {
  return `${submission.id}:${submission.revision}`;
}

const notificationMessages: Record<SpotlightNotificationStatus, string> = {
  sent: "結果をメールでお知らせしました。",
  pending: "結果のメールを送れなかったため、自動で再送します。",
  failed: "結果のメールを送れず、再送を終了しました。",
  skipped: "メールアドレスが未登録のため、結果のメールは送りません。",
};

export function SpotlightSubmissionsView({ submissions }: { submissions: SpotlightSubmissionDetail[] }) {
  const router = useRouter();
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [invalidatedKeys, setInvalidatedKeys] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [pending, startTransition] = useTransition();
  const selected = submissions.find((submission) => submissionKey(submission) === selectedKey);
  const sorted = [...submissions].sort((a, b) => a.submittedAt - b.submittedAt || a.id.localeCompare(b.id));

  const review = (submission: SpotlightSubmissionDetail, approve: boolean) => {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      try {
        const result = approve
          ? await approveSpotlightSubmissionAction(submission.id, submission.revision)
          : await rejectSpotlightSubmissionAction(submission.id, submission.revision);
        if (result.error && result.error.code !== "conflict") {
          setError(result.error.message);
          return;
        }
        setSelectedKey(null);
        // 再取得が終わるまでは、処理前の同じrevisionを開き直せないようにする。
        setInvalidatedKeys((keys) => [...keys, submissionKey(submission)]);
        if (result.error) {
          setError("他のスタッフが処理しました。最新の一覧を読み込みます。");
        } else {
          const reviewMessage = approve ? "掲載しました。内容の修正は「掲載メンバー」から行えます。" : "申請を却下しました。";
          setMessage(`${reviewMessage}${notificationMessages[result.data.notificationStatus]}`);
        }
        router.refresh();
      } catch {
        setError("処理結果を確認できませんでした。もう一度お試しください。");
      }
    });
  };

  return (
    <>
      {error ? <p className={styles.formError} role="alert">{error}</p> : null}
      {message ? <p className={styles.formSuccess} role="status">{message}</p> : null}
      <section className={styles.panel} aria-label="確認待ち一覧">
        <h2 className={styles.panelTitle}>確認待ち</h2>
        <p className={styles.panelDesc}>申請が古い順に表示しています。内容を確認し、「掲載する」を押すとサイネージに掲載されます。</p>
        {sorted.length === 0 ? (
          <p className={styles.empty}>確認待ちの申請はありません。</p>
        ) : (
          <ul className={styles.list}>
            {sorted.map((submission) => (
              <li key={submission.id} className={styles.listRow} style={{ gridTemplateColumns: "minmax(0, 1fr) 180px auto" }}>
                <div className={styles.rowMain}>
                  <p className={styles.rowTitle}>{submission.personName}さん</p>
                  <p className={styles.rowBody}>{submission.companyName}</p>
                </div>
                <time className={styles.hint} dateTime={new Date(submission.submittedAt * 1000).toISOString()}>
                  {dateTime.format(submission.submittedAt * 1000)}
                </time>
                <button
                  type="button"
                  className={styles.secondaryButton}
                  disabled={pending || invalidatedKeys.includes(submissionKey(submission))}
                  onClick={() => {
                    setSelectedKey(submissionKey(submission));
                    setError(null);
                    setMessage(null);
                  }}
                >
                  内容を確認
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
      {selected ? (
        <section className={styles.panel} aria-label="申請内容の確認">
          <div className={styles.panelHead}>
            <div>
              <h2 className={styles.panelTitle}>{selected.personName}さんの申請</h2>
              <p className={styles.panelDesc}>申請日時：{dateTime.format(selected.submittedAt * 1000)}</p>
            </div>
            <button type="button" className={styles.secondaryButton} disabled={pending} onClick={() => setSelectedKey(null)}>閉じる</button>
          </div>
          <dl className={styles.formGrid}>
            {[
              ["会社名・所属", selected.payload.companyName],
              ["名前", selected.payload.personName],
              ["メールアドレス（結果の通知先。サイネージには表示しません）", selected.contactEmail ?? "未登録（通知なし）"],
              ["ふりがな", selected.payload.personNameKana],
              ["肩書き", selected.payload.role],
              ["ひとこと", selected.payload.quote],
              ["紹介文", selected.payload.bio],
              ["タグ", selected.payload.tags.join("・")],
              ["ホームページ（サイネージにQRコードで出します）", selected.payload.websiteUrl ?? ""],
              ["掲載先への同意日時", dateTime.format(selected.consentedAt * 1000)],
            ].map(([label, value]) => (
              <div key={label} className={styles.field}>
                <dt className={styles.label}>{label}</dt>
                <dd style={{ fontSize: 14, lineHeight: 1.7, whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{value || "未入力"}</dd>
              </div>
            ))}
            {/* 会社のロゴはサイネージに出さないので、確認にも出さない（2026-10-01 ユーザー指示） */}
            <div className={styles.field}>
              <dt className={styles.label}>本人写真</dt>
              <dd>
                {selected.photoUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={selected.photoUrl} alt="本人写真" style={{ width: "100%", maxWidth: 300, height: 180, objectFit: "contain", objectPosition: "left" }} />
                ) : <span className={styles.hint}>未登録</span>}
              </dd>
            </div>
          </dl>
          <div style={{ marginTop: 24 }}>
            <h3 className={styles.panelTitle}>掲載イメージ</h3>
            <div style={{ marginTop: 12 }}>
              <SpotlightPreview payload={selected.payload} photoUrl={selected.photoUrl} />
            </div>
          </div>
          <div className={styles.rowActions} style={{ marginTop: 24 }}>
            <button type="button" className={styles.primaryButton} disabled={pending} onClick={() => review(selected, true)}>
              {pending ? "処理中…" : "掲載する"}
            </button>
            <button
              type="button"
              className={`${styles.secondaryButton} ${styles.dangerButton}`}
              disabled={pending}
              onClick={() => setConfirm({
                title: "申請を却下しますか？",
                body: `「${selected.personName}さん」の申請を却下します。サイネージには掲載されません。`,
                confirmLabel: "却下する",
                danger: true,
                onConfirm: () => review(selected, false),
              })}
            >
              却下
            </button>
          </div>
        </section>
      ) : null}
      {confirm ? <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} /> : null}
    </>
  );
}
