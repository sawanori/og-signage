"use client";

/**
 * 表示スケジュール（Administrator）。曜日ごとに「終日表示」か「時間帯を指定」かを選ぶ。
 * 未設定（終日表示）の曜日は保存時に行を送らない（lib/services/schedule.ts が全件を置き換える）。
 */
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { updateDisplayScheduleAction } from "@/app/admin/_actions/content";
import { WEEKDAY_JA } from "@/components/admin/format";
import type { Weekday } from "@/lib/dates";
import type { DisplayScheduleRow } from "@/lib/services/schedule";
import styles from "./settings.module.css";

const SAVED_MESSAGE = "保存しました。サイネージには 30 秒以内に反映されます。";
const WEEKDAYS: Weekday[] = [0, 1, 2, 3, 4, 5, 6];
const DEFAULT_START = "08:00";
const DEFAULT_END = "22:00";

type DayState = { active: boolean; start: string; end: string };

function toDayStates(entries: DisplayScheduleRow[]): Record<Weekday, DayState> {
  const byWeekday = new Map(entries.map((e) => [e.weekday, e]));
  const result = {} as Record<Weekday, DayState>;
  for (const w of WEEKDAYS) {
    const entry = byWeekday.get(w);
    result[w] = entry ? { active: true, start: entry.startTime, end: entry.endTime } : { active: false, start: DEFAULT_START, end: DEFAULT_END };
  }
  return result;
}

export function ScheduleView({ entries }: { entries: DisplayScheduleRow[] }) {
  const [days, setDays] = useState<Record<Weekday, DayState>>(() => toDayStates(entries));
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const setDay = (w: Weekday, patch: Partial<DayState>) => {
    setDays((prev) => ({ ...prev, [w]: { ...prev[w], ...patch } }));
  };

  const save = () => {
    setSuccess(false);
    for (const w of WEEKDAYS) {
      const d = days[w];
      if (d.active && d.start === d.end) {
        setError(`${WEEKDAY_JA[w]}曜日は開始と終了に同じ時刻を指定できません`);
        return;
      }
    }
    const entriesInput = WEEKDAYS.filter((w) => days[w].active).map((w) => ({
      weekday: w,
      startTime: days[w].start,
      endTime: days[w].end,
      enabled: true,
    }));
    startTransition(async () => {
      const result = await updateDisplayScheduleAction({ entries: entriesInput });
      if (result.error) {
        setError(result.error.message);
        return;
      }
      setError(null);
      setSuccess(true);
      router.refresh();
    });
  };

  return (
    <div className={styles.page}>
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.pageTitle}>表示スケジュール</h1>
          <p className={styles.pageDesc}>
            曜日ごとにサイネージを表示する時間帯を設定します。時間外は画面出力を止め、動画も再生しません。
          </p>
        </div>
      </div>

      <section className={styles.panel} aria-label="曜日ごとの表示時間帯">
        <h2 className={styles.panelTitle}>曜日ごとの表示時間帯</h2>
        <p className={styles.panelDesc}>
          「時間帯を指定」をOFFのままにした曜日は、終日表示されます。終了が開始より前の場合は翌日の終了時刻まで表示します。
        </p>
        <div className={styles.scheduleList}>
          {WEEKDAYS.map((w) => {
            const d = days[w];
            return (
              <div key={w} className={styles.scheduleRow}>
                <span className={styles.weekdayLabel}>{WEEKDAY_JA[w]}曜日</span>
                <button
                  type="button"
                  role="switch"
                  aria-checked={d.active}
                  aria-label={`${WEEKDAY_JA[w]}曜日の時間帯指定`}
                  className={styles.toggle}
                  disabled={pending}
                  onClick={() => setDay(w, { active: !d.active })}
                >
                  {d.active ? "ON" : "OFF"}
                </button>
                <span className={styles.scheduleStatus}>{d.active ? "時間帯を指定" : "終日表示"}</span>
                {d.active ? (
                  <div className={styles.timeGroup}>
                    <input
                      type="time"
                      className={styles.timeInput}
                      aria-label={`${WEEKDAY_JA[w]}曜日の開始時刻`}
                      value={d.start}
                      disabled={pending}
                      onChange={(e) => setDay(w, { start: e.target.value })}
                    />
                    <span className={styles.timeSep}>〜</span>
                    <input
                      type="time"
                      className={styles.timeInput}
                      aria-label={`${WEEKDAY_JA[w]}曜日の終了時刻`}
                      value={d.end}
                      disabled={pending}
                      onChange={(e) => setDay(w, { end: e.target.value })}
                    />
                  </div>
                ) : (
                  <div className={styles.timeGroup} />
                )}
              </div>
            );
          })}
        </div>
        <div className={styles.imageActions} style={{ marginTop: 18 }}>
          <button type="button" className={styles.primaryButton} disabled={pending} onClick={save}>
            保存する
          </button>
        </div>
        {error ? (
          <p className={styles.formError} role="alert">
            {error}
          </p>
        ) : null}
        {success ? <p className={styles.formSuccess}>{SAVED_MESSAGE}</p> : null}
      </section>
    </div>
  );
}
