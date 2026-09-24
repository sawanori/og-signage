"use client";

/** 今週のカレンダー（月曜始まり）。イベントのある日にカテゴリ色の点を出す。前後の週へ送れる */
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { SECONDS_PER_DAY, isSameTokyoDay, startOfTokyoWeek, tokyoParts } from "@/lib/dates";
import styles from "./admin.module.css";
import type { DashboardEvent } from "./dashboard-types";
import { WEEKDAY_JA } from "./format";

const NO_CATEGORY_COLOR = "#94a0b2";
const MAX_DOTS = 3;

export function WeekCalendar({ events, now }: { events: DashboardEvent[]; now: number }) {
  const thisWeek = startOfTokyoWeek(now);
  const [weekStart, setWeekStart] = useState(thisWeek);
  const first = tokyoParts(weekStart);

  const days = Array.from({ length: 7 }, (_, i) => {
    const start = weekStart + i * SECONDS_PER_DAY;
    const dayEvents = events
      .filter((e) => e.startAt >= start && e.startAt < start + SECONDS_PER_DAY)
      .sort((a, b) => a.startAt - b.startAt);
    return { start, parts: tokyoParts(start), isToday: isSameTokyoDay(start, now), events: dayEvents };
  });

  return (
    <section className={`${styles.card} ${styles.calendar}`} aria-label="今週のカレンダー">
      <div className={styles.calendarHead}>
        <h2 className={styles.cardTitle}>今週のカレンダー</h2>
        <div className={styles.calendarNav}>
          <button
            type="button"
            className={styles.roundButton}
            aria-label="前の週"
            onClick={() => setWeekStart((w) => w - 7 * SECONDS_PER_DAY)}
          >
            <ChevronLeft size={17} strokeWidth={2.4} aria-hidden />
          </button>
          <button
            type="button"
            className={styles.roundButton}
            aria-label="次の週"
            onClick={() => setWeekStart((w) => w + 7 * SECONDS_PER_DAY)}
          >
            <ChevronRight size={17} strokeWidth={2.4} aria-hidden />
          </button>
        </div>
        <p className={styles.calendarMonth}>
          {first.year}年 {first.month}月
        </p>
        <button type="button" className={styles.todayButton} onClick={() => setWeekStart(thisWeek)}>
          今日
        </button>
      </div>
      <ol className={styles.week}>
        {days.map((d) => (
          <li
            key={d.start}
            className={`${styles.day} ${d.isToday ? styles.dayToday : ""}`}
            aria-current={d.isToday ? "date" : undefined}
            aria-label={`${d.parts.month}月${d.parts.day}日 ${d.events.length > 0 ? `イベント ${d.events.length} 件` : "イベントなし"}`}
          >
            <span className={styles.dayNum}>{d.parts.day}</span>
            <span
              className={`${styles.dayName} ${d.parts.weekday === 6 ? styles.daySat : ""} ${d.parts.weekday === 0 ? styles.daySun : ""}`}
            >
              {WEEKDAY_JA[d.parts.weekday]}
            </span>
            <span className={styles.dots}>
              {d.events.slice(0, MAX_DOTS).map((e) => (
                <span
                  key={e.id}
                  className={styles.dot}
                  style={{ background: e.category?.color ?? NO_CATEGORY_COLOR }}
                  title={e.title}
                />
              ))}
            </span>
          </li>
        ))}
      </ol>
    </section>
  );
}
