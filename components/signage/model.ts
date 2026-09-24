/**
 * 表示ページの表示内容を config と現在時刻から組み立てる。
 * 業務規則（どのイベントを出すか・状態・お知らせ・天気・表示スケジュール）は lib/display-rules.ts に任せ、
 * ここでは表示用の文字列への整形だけを行う。
 */
import type { MediaRef, SignageConfig, SignageEvent, SignageNotice, Weather } from "@/lib/config-schema";
import { tokyoParts } from "@/lib/dates";
import {
  isWithinDisplaySchedule,
  selectMainEvent,
  selectNotice,
  selectThisWeek,
  selectUpcomingEvents,
  shouldShowWeather,
  type MainEventSelection,
  type WeekDay,
} from "@/lib/display-rules";

export type Orientation = "portrait" | "landscape";

/** mediaRef から画像の URL を決める関数（クラウドは管理用素材 API、Pi は /local/media/<sha256>） */
export type ResolveMediaUrl = (ref: MediaRef) => string;

export type SignageView = {
  /** 表示スケジュール上、今表示してよいか */
  visible: boolean;
  main: MainEventSelection;
  upcoming: SignageEvent[];
  week: WeekDay[];
  notice: SignageNotice | null;
  weather: Weather | null;
  clock: ClockText;
};

export type ClockText = {
  /** 17:42 */
  time: string;
  year: number;
  month: number;
  day: number;
  /** Wed */
  weekdayShort: string;
};

const WEEKDAY_EN = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

export function buildView(config: SignageConfig, now: number, timeSynced: boolean): SignageView {
  const main = selectMainEvent(config.events, now);
  return {
    visible: isWithinDisplaySchedule(config.schedule, now, timeSynced),
    main,
    upcoming: selectUpcomingEvents(config.events, now, main),
    week: selectThisWeek(config.events, now),
    notice: selectNotice(config.notices, now),
    weather: shouldShowWeather(config.weather, now, timeSynced) ? config.weather : null,
    clock: clockText(now),
  };
}

export function clockText(unixSeconds: number): ClockText {
  const p = tokyoParts(unixSeconds);
  return {
    time: `${pad2(p.hour)}:${pad2(p.minute)}`,
    year: p.year,
    month: p.month,
    day: p.day,
    weekdayShort: WEEKDAY_EN[p.weekday],
  };
}

/** 19:30 */
export function formatTime(unixSeconds: number): string {
  const p = tokyoParts(unixSeconds);
  return `${pad2(p.hour)}:${pad2(p.minute)}`;
}

/** 19:30 - 21:30。終了未設定なら開始だけ */
export function formatTimeRange(event: Pick<SignageEvent, "startAt" | "endAt">): string {
  const start = formatTime(event.startAt);
  return event.endAt === null ? `${start} -` : `${start} - ${formatTime(event.endAt)}`;
}

/** 9.26 */
export function formatMonthDay(unixSeconds: number): string {
  const p = tokyoParts(unixSeconds);
  return `${p.month}.${p.day}`;
}

/** FRI */
export function formatWeekdayUpper(unixSeconds: number): string {
  return WEEKDAY_EN[tokyoParts(unixSeconds).weekday].toUpperCase();
}

export function formatParticipation(event: Pick<SignageEvent, "participation" | "capacity" | "participantCount">): string {
  if (event.participation === "free") return "参加自由（予約不要）";
  if (event.capacity === null) return "定員あり（要予約）";
  if (event.participantCount === null) return `定員 ${event.capacity}名（要予約）`;
  const left = Math.max(event.capacity - event.participantCount, 0);
  return left === 0 ? `定員 ${event.capacity}名（満員）` : `定員 ${event.capacity}名（残り${left}名）`;
}

/** 主イベントの状態の見出し */
export function stateLabel(state: "today" | "starting_soon" | "now_happening"): { en: string; ja: string } {
  switch (state) {
    case "starting_soon":
      return { en: "STARTING SOON", ja: "まもなく開始" };
    case "now_happening":
      return { en: "NOW HAPPENING", ja: "開催中" };
    default:
      return { en: "TODAY", ja: "本日のイベント" };
  }
}

/**
 * フッターのキャッチコピー。1 行目を大きな英文、2 行目以降を添え書きとして扱う。
 */
export function splitFooterCopy(copy: string | null): { lead: string | null; sub: string[] } {
  if (!copy) return { lead: null, sub: [] };
  const lines = copy.split("\n").map((l) => l.trim()).filter(Boolean);
  return { lead: lines[0] ?? null, sub: lines.slice(1) };
}

/** イベントのキャッチコピー。" / " か改行で行を分ける */
export function splitCatchCopy(copy: string | null): string[] {
  if (!copy) return [];
  return copy.split(/\s*\/\s*|\n/).map((l) => l.trim()).filter(Boolean);
}

/**
 * カテゴリ色を背景に薄く敷いた色（タグ用）。白との混色で、ratio がカテゴリ色の割合。
 */
export function tint(hex: string, ratio: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(c * ratio + 255 * (1 - ratio));
  const r = mix((n >> 16) & 0xff);
  const g = mix((n >> 8) & 0xff);
  const b = mix(n & 0xff);
  return `rgb(${r}, ${g}, ${b})`;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
