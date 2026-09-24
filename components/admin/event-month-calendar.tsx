"use client";

/**
 * 月のカレンダー（月曜始まり、日本時間）。イベントのある日にカテゴリ色で予定を出し、押すと編集へ進む。
 */
import { ChevronLeft, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useState, type CSSProperties } from "react";
import { SECONDS_PER_DAY, isSameTokyoDay, startOfTokyoWeek, tokyoDateTime, tokyoParts } from "@/lib/dates";
import admin from "./admin.module.css";
import type { ManagedEvent } from "./event-types";
import styles from "./events.module.css";
import { WEEKDAY_JA, formatHm } from "./format";

const NO_CATEGORY_COLOR = "#94a0b2";
const MAX_PER_DAY = 3;
/** 月曜始まりの曜日（0 = 日曜） */
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

type Month = { year: number; month: number };

function shift({ year, month }: Month, delta: number): Month {
  const index = year * 12 + (month - 1) + delta;
  return { year: Math.floor(index / 12), month: (index % 12) + 1 };
}

export function EventMonthCalendar({ events, now }: { events: ManagedEvent[]; now: number }) {
  const today = tokyoParts(now);
  const [shown, setShown] = useState<Month>({ year: today.year, month: today.month });

  const first = tokyoDateTime(shown.year, shown.month, 1);
  const gridStart = startOfTokyoWeek(first);
  const next = shift(shown, 1);
  const monthEnd = tokyoDateTime(next.year, next.month, 1);
  const weeks = Math.ceil((monthEnd - gridStart) / (7 * SECONDS_PER_DAY));

  const days = Array.from({ length: weeks * 7 }, (_, i) => {
    const start = gridStart + i * SECONDS_PER_DAY;
    const parts = tokyoParts(start);
    return {
      start,
      parts,
      inMonth: parts.month === shown.month,
      isToday: isSameTokyoDay(start, now),
      events: events.filter((e) => e.startAt >= start && e.startAt < start + SECONDS_PER_DAY),
    };
  });

  return (
    <div className={styles.calendar}>
      <div className={styles.calendarHead}>
        <button type="button" className={admin.roundButton} aria-label="前の月" onClick={() => setShown((m) => shift(m, -1))}>
          <ChevronLeft size={17} strokeWidth={2.4} aria-hidden />
        </button>
        <button type="button" className={admin.roundButton} aria-label="次の月" onClick={() => setShown((m) => shift(m, 1))}>
          <ChevronRight size={17} strokeWidth={2.4} aria-hidden />
        </button>
        <p className={styles.calendarMonth} aria-live="polite">
          {shown.year}年 {shown.month}月
        </p>
        <button
          type="button"
          className={`${admin.todayButton} ${styles.thisMonth}`}
          onClick={() => setShown({ year: today.year, month: today.month })}
        >
          今月
        </button>
      </div>

      <div className={styles.monthGrid} role="grid" aria-label={`${shown.year}年${shown.month}月のイベント`}>
        <div className={styles.weekdayRow} role="row">
          {WEEK_ORDER.map((w) => (
            <span
              key={w}
              role="columnheader"
              className={`${styles.weekday} ${w === 6 ? admin.daySat : ""} ${w === 0 ? admin.daySun : ""}`}
            >
              {WEEKDAY_JA[w]}
            </span>
          ))}
        </div>
        {Array.from({ length: weeks }, (_, w) => (
          <div key={w} className={styles.monthWeek} role="row">
            {days.slice(w * 7, w * 7 + 7).map((d) => (
              <div
                key={d.start}
                role="gridcell"
                className={styles.monthDay}
                data-outside={!d.inMonth || undefined}
                aria-current={d.isToday ? "date" : undefined}
                aria-label={`${d.parts.month}月${d.parts.day}日 ${d.events.length > 0 ? `イベント ${d.events.length} 件` : "イベントなし"}`}
              >
                <span
                  className={`${styles.monthDayNum} ${d.parts.weekday === 6 ? admin.daySat : ""} ${d.parts.weekday === 0 ? admin.daySun : ""}`}
                  data-today={d.isToday || undefined}
                >
                  {d.parts.day}
                </span>
                <ul className={styles.dayEvents}>
                  {d.events.slice(0, MAX_PER_DAY).map((e) => (
                    <li key={e.id}>
                      <Link
                        href={`/admin/events/${e.id}`}
                        className={styles.dayEvent}
                        data-draft={e.status === "draft" || undefined}
                        style={{ "--event-color": e.category?.color ?? NO_CATEGORY_COLOR } as CSSProperties}
                        title={`${e.title}${e.status === "draft" ? "（下書き）" : ""}`}
                      >
                        <span className={styles.dayEventTime}>{formatHm(e.startAt)}</span>
                        <span className={styles.dayEventTitle}>
                          {e.emoji ? `${e.emoji} ` : ""}
                          {e.title}
                        </span>
                      </Link>
                    </li>
                  ))}
                </ul>
                {d.events.length > MAX_PER_DAY ? (
                  <span className={styles.dayMore}>ほか {d.events.length - MAX_PER_DAY} 件</span>
                ) : null}
              </div>
            ))}
          </div>
        ))}
      </div>
      <p className={styles.calendarLegend}>
        <span className={styles.legendDraft} aria-hidden /> 点線の枠は下書き（サイネージには表示されません）
      </p>
    </div>
  );
}
