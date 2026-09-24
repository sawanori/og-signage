/**
 * 今日のイベント。主イベントの選び方と状態は表示ページと同じ規則（lib/display-rules.ts）。
 * 今日のイベントがなければ次のイベントを案内する。
 */
import Link from "next/link";
import { selectMainEvent } from "@/lib/display-rules";
import styles from "./admin.module.css";
import { PinFillIcon, UsersFillIcon } from "./icons";
import type { DashboardEvent } from "./dashboard-types";
import { formatMonthDay, formatParticipants, formatTimeRange } from "./format";

const STATE_LABELS = { now_happening: "開催中", starting_soon: "まもなく", today: "本日" } as const;

export function TodayEventCard({ events, now }: { events: DashboardEvent[]; now: number }) {
  const main = selectMainEvent(events, now);

  if (main.kind !== "today") {
    return (
      <section className={`${styles.card} ${styles.todayCard}`} aria-label="今日のイベント">
        <div className={styles.todayHead}>
          <h2 className={styles.todayLabel}>今日のイベント</h2>
        </div>
        <p className={styles.todayNext}>
          今日のイベントはありません。
          <br />
          {main.kind === "next"
            ? `次は ${formatMonthDay(main.event.startAt)} の「${main.event.title}」です。`
            : "予定されているイベントはまだありません。"}
        </p>
        <Link href="/admin/events/new" className={styles.greenButton} style={{ marginTop: 14 }}>
          イベントを作成
        </Link>
      </section>
    );
  }

  const e = main.event;
  const participants = formatParticipants(e.participantCount, e.capacity);
  return (
    <section className={`${styles.card} ${styles.todayCard}`} aria-label="今日のイベント">
      <div className={styles.todayHead}>
        <h2 className={styles.todayLabel}>今日のイベント</h2>
        <span className={styles.stateBadge} data-state={main.state}>
          {STATE_LABELS[main.state]}
        </span>
        <span className={styles.todayTime}>{formatTimeRange(e.startAt, e.endAt)}</span>
      </div>
      <div className={styles.todayBody}>
        {e.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className={styles.todayPhoto} src={e.imageUrl} alt="" />
        ) : (
          <div className={styles.todayPhoto} style={{ background: e.category?.color ?? undefined }} />
        )}
        <div style={{ minWidth: 0 }}>
          <p className={styles.todayTitle}>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{e.title}</span>
            {e.emoji ? (
              <span className={styles.emoji} aria-hidden>
                {e.emoji}
              </span>
            ) : null}
          </p>
          <p className={styles.todayMeta}>
            {e.location ? (
              <span className={styles.metaItem}>
                <PinFillIcon className={styles.metaIcon} />
                {e.location}
              </span>
            ) : null}
            {participants ? (
              <span className={styles.metaItem}>
                <UsersFillIcon className={styles.metaIcon} />
                {participants}
              </span>
            ) : null}
          </p>
          <Link href={`/admin/events/${e.id}`} className={styles.greenButton}>
            イベントを編集
          </Link>
        </div>
      </div>
    </section>
  );
}
