/** ダッシュボードの日時・長さの書式（日本時間） */
import { tokyoParts } from "@/lib/dates";

export const WEEKDAY_JA = ["日", "月", "火", "水", "木", "金", "土"] as const;

const pad2 = (n: number) => String(n).padStart(2, "0");

/** 19:30 */
export function formatHm(unix: number): string {
  const p = tokyoParts(unix);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** 19:30 - 21:30（終了なしは「19:30 -」） */
export function formatTimeRange(startAt: number, endAt: number | null): string {
  return endAt === null ? `${formatHm(startAt)} -` : `${formatHm(startAt)} - ${formatHm(endAt)}`;
}

/** 9月24日（水） */
export function formatMonthDay(unix: number): string {
  const p = tokyoParts(unix);
  return `${p.month}月${p.day}日（${WEEKDAY_JA[p.weekday]}）`;
}

/** 00:30 */
export function formatDuration(seconds: number | null): string {
  if (seconds === null) return "--:--";
  const s = Math.round(seconds);
  return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
}

/** 参加人数。定員があれば「12 / 20 人」、無ければ「12 人」、どちらも無ければ null */
export function formatParticipants(count: number | null, capacity: number | null): string | null {
  if (count === null && capacity === null) return null;
  if (capacity === null) return `${count} 人`;
  return `${count ?? 0} / ${capacity} 人`;
}
