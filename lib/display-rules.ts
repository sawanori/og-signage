/**
 * 表示の業務規則（実装計画 8.1 節・8.3 節）。表示ページと管理画面プレビューで共用する純関数。
 * 時刻は UNIX 秒、日付の境目は Asia/Tokyo。
 */
import type {
  ScheduleEntry,
  SignageEvent,
  SignageNotice,
  Weather,
} from "./config-schema";
import {
  SECONDS_PER_DAY,
  endOfTokyoDay,
  isMinuteInRange,
  isSameTokyoDay,
  parseHHMM,
  startOfTokyoWeek,
  tokyoDateKey,
  tokyoMinutesOfDay,
  tokyoWeekday,
  type Weekday,
} from "./dates";

export const STARTING_SOON_SECONDS = 30 * 60;
/** Upcoming の最大件数（横型。2026-09-25 ユーザー指示で 4 → 5 → 6、2026-09-26 に 5。縦型は 3 行） */
export const UPCOMING_LIMIT = 5;
export const WEATHER_MAX_AGE_SECONDS = 3 * 60 * 60;

type EventTiming = Pick<SignageEvent, "startAt" | "endAt">;
type OrderedEvent = Pick<SignageEvent, "id" | "startAt" | "createdAt">;

export type EventState =
  /** 今日より後（まだ 30 分前に入っていない明日以降） */
  | "upcoming"
  /** 今日の予定で、開始 30 分前より前 */
  | "today"
  /** 開始 30 分前から開始まで */
  | "starting_soon"
  /** 開始から終了まで（終了時刻ちょうどを含む） */
  | "now_happening"
  | "ended";

export function isPublished(event: Pick<SignageEvent, "status">): boolean {
  return event.status === "published";
}

/** 終了日時。未設定なら開始日の 23:59:59 */
export function effectiveEndAt(event: EventTiming): number {
  return event.endAt ?? endOfTokyoDay(event.startAt);
}

export function getEventState(event: EventTiming, now: number): EventState {
  const end = effectiveEndAt(event);
  if (now > end) return "ended";
  if (now >= event.startAt) return "now_happening";
  if (now >= event.startAt - STARTING_SOON_SECONDS) return "starting_soon";
  if (isSameTokyoDay(event.startAt, now)) return "today";
  return "upcoming";
}

/** 開始が早い順、次に作成が早い順、最後に id（結果を決定的にするため） */
export function compareEventOrder(a: OrderedEvent, b: OrderedEvent): number {
  return a.startAt - b.startAt || a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export type MainEventSelection<E extends SignageEvent = SignageEvent> =
  /** 今日の主イベント（大きく表示） */
  | { kind: "today"; event: E; state: "today" | "starting_soon" | "now_happening" }
  /** 今日のイベントがないときの「次のイベント」（小さく表示） */
  | { kind: "next"; event: E }
  /** 表示するイベントがない（ハウスのキャッチコピーを出す） */
  | { kind: "none" };

/** 大きな欄のスライドショーで 1 枚を出す秒数（説明と日時・場所を読み切れる長さ。2026-09-25 ユーザー指示で 10→15 秒、2026-09-27 に 17 秒） */
export const HERO_SLIDE_SECONDS = 17;

export type HeroSlideState = Exclude<EventState, "ended">;
export type HeroSlide<E extends SignageEvent = SignageEvent> = { event: E; state: HeroSlideState };

/**
 * 大きな欄（写真つきで詳細を出す欄）のスライドショーに流すイベント。
 * 終わっていない公開イベントをすべて、開催中を先頭に、残りは開始が早い順で並べる。
 * サイネージはタッチ操作ができず、各イベントの詳細はこの欄でしか見られないため（2026-09-25 ユーザー指示）。
 */
export function selectHeroSlides<E extends SignageEvent>(events: readonly E[], now: number): HeroSlide<E>[] {
  const slides = events
    .filter((e) => isPublished(e))
    .map((event) => ({ event, state: getEventState(event, now) }))
    .filter((slide): slide is HeroSlide<E> => slide.state !== "ended");
  const byOrder = (a: HeroSlide<E>, b: HeroSlide<E>) => compareEventOrder(a.event, b.event);
  const happening = slides.filter((slide) => slide.state === "now_happening").sort(byOrder);
  const rest = slides.filter((slide) => slide.state !== "now_happening").sort(byOrder);
  return [...happening, ...rest];
}

/** 今出すスライドの番号。時刻だけで決めるので、Pi・Web・管理画面のプレビューで同じ 1 枚が出る */
export function heroSlideIndex(now: number, count: number): number {
  return count <= 1 ? 0 : Math.floor(now / HERO_SLIDE_SECONDS) % count;
}

/** メンバー紹介（MEMBER SPOTLIGHT）で 1 人を出す秒数。大きな欄と同じ長さにして、交互に切り替わるようにする */
export const SPOTLIGHT_SLIDE_SECONDS = HERO_SLIDE_SECONDS;
/** 大きな欄のスライドと同じ瞬間に切り替わらないよう、半分ほどずらす */
export const SPOTLIGHT_OFFSET_SECONDS = Math.floor(SPOTLIGHT_SLIDE_SECONDS / 2);

/** 今出すメンバー紹介の番号。大きな欄のスライドと同じく時刻だけで決める */
export function spotlightIndex(now: number, count: number): number {
  return count <= 1 ? 0 : Math.floor((now + SPOTLIGHT_OFFSET_SECONDS) / SPOTLIGHT_SLIDE_SECONDS) % count;
}

/**
 * 今日の主イベント。開催中を優先し、なければ今日これから始まるもの。
 * 前日から続いて開催中のもの（日またぎ）も今日のイベントに含める。
 */
export function selectMainEvent<E extends SignageEvent>(events: readonly E[], now: number): MainEventSelection<E> {
  const live = events.filter((e) => isPublished(e) && getEventState(e, now) !== "ended");

  const happening = live.filter((e) => getEventState(e, now) === "now_happening").sort(compareEventOrder);
  if (happening.length > 0) return { kind: "today", event: happening[0], state: "now_happening" };

  const laterToday = live.filter((e) => e.startAt > now && isSameTokyoDay(e.startAt, now)).sort(compareEventOrder);
  if (laterToday.length > 0) {
    const event = laterToday[0];
    return { kind: "today", event, state: getEventState(event, now) as "today" | "starting_soon" };
  }

  const next = live.filter((e) => e.startAt > now).sort(compareEventOrder);
  if (next.length > 0) return { kind: "next", event: next[0] };

  return { kind: "none" };
}

/**
 * Upcoming。主イベントを除く、終わっていない公開イベントのうち主イベントより後の順番のものを
 * 開始順に最大 UPCOMING_LIMIT 件。今日のうち主イベントより後のもの（同時刻で作成が遅いものを含む）も入る。
 */
export function selectUpcomingEvents<E extends SignageEvent>(
  events: readonly E[],
  now: number,
  main: MainEventSelection<E>,
  limit = UPCOMING_LIMIT,
): E[] {
  const mainEvent = main.kind === "none" ? null : main.event;
  return events
    .filter((e) => isPublished(e) && getEventState(e, now) !== "ended")
    .filter((e) => (mainEvent ? e.id !== mainEvent.id && compareEventOrder(e, mainEvent) > 0 : true))
    .sort(compareEventOrder)
    .slice(0, limit);
}

export type WeekDay<E extends SignageEvent = SignageEvent> = {
  /** 日本時間の YYYY-MM-DD */
  dateKey: string;
  weekday: Weekday;
  /** その日の 0:00:00（UNIX 秒） */
  startAt: number;
  isToday: boolean;
  /** その日に始まる公開イベント（開始順） */
  events: E[];
};

/** 今週（月曜始まりの 7 日間）の予定。終わったイベントも含める */
export function selectThisWeek<E extends SignageEvent>(events: readonly E[], now: number): WeekDay<E>[] {
  const weekStart = startOfTokyoWeek(now);
  const published = events.filter(isPublished).sort(compareEventOrder);
  return Array.from({ length: 7 }, (_, i) => {
    const dayStart = weekStart + i * SECONDS_PER_DAY;
    const dayEnd = dayStart + SECONDS_PER_DAY;
    return {
      dateKey: tokyoDateKey(dayStart),
      weekday: tokyoWeekday(dayStart),
      startAt: dayStart,
      isToday: isSameTokyoDay(dayStart, now),
      events: published.filter((e) => e.startAt >= dayStart && e.startAt < dayEnd),
    };
  });
}

/** お知らせが今表示対象か。時間帯は [開始, 終了)、開始 > 終了は日またぎ */
export function isNoticeActive(notice: SignageNotice, now: number): boolean {
  if (!notice.enabled) return false;
  if (notice.displayMode === "always") return true;
  if (notice.displayStartTime === null || notice.displayEndTime === null) return false;
  return isMinuteInRange(
    tokyoMinutesOfDay(now),
    parseHHMM(notice.displayStartTime),
    parseHHMM(notice.displayEndTime),
  );
}

/** 表示するお知らせ。対象が複数なら更新が新しい 1 件 */
export function selectNotice<N extends SignageNotice>(notices: readonly N[], now: number): N | null {
  const active = notices
    .filter((n) => isNoticeActive(n, now))
    .sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return active[0] ?? null;
}

/**
 * 表示スケジュール上、今表示してよいか。
 * - 未設定の曜日は終日表示。enabled = false の曜日は終日非表示（前日から日をまたいだ分は表示）。
 * - 時間帯は [開始, 終了)。開始 > 終了は翌日の終了時刻まで（前日の設定が翌日の早朝を覆う）。
 * - 時刻が未同期のときは消灯しない（常に true）。
 */
export function isWithinDisplaySchedule(
  schedule: readonly ScheduleEntry[],
  now: number,
  timeSynced: boolean,
): boolean {
  if (!timeSynced) return true;

  const today = tokyoWeekday(now);
  const yesterday = ((today + 6) % 7) as Weekday;
  const minutes = tokyoMinutesOfDay(now);
  const todayEntry = schedule.find((s) => s.weekday === today);
  const yesterdayEntry = schedule.find((s) => s.weekday === yesterday);

  // 前日の日またぎ分（翌日 0:00〜終了時刻）
  if (yesterdayEntry?.enabled) {
    const start = parseHHMM(yesterdayEntry.startTime);
    const end = parseHHMM(yesterdayEntry.endTime);
    if (start > end && minutes < end) return true;
  }

  if (!todayEntry) return true;
  if (!todayEntry.enabled) return false;

  const start = parseHHMM(todayEntry.startTime);
  const end = parseHHMM(todayEntry.endTime);
  if (start === end) return true;
  if (start < end) return minutes >= start && minutes < end;
  // 日またぎ: 当日分は開始〜24:00。0:00〜終了は前日の設定として上で判定済み
  return minutes >= start;
}

/** 天気欄を出すか。取得から 3 時間を超えた、または時刻未同期なら出さない */
export function shouldShowWeather(weather: Weather | null, now: number, timeSynced: boolean): boolean {
  if (!weather || !timeSynced) return false;
  return now - weather.fetchedAt <= WEATHER_MAX_AGE_SECONDS;
}

export type NextVideoInput = {
  intervalMinutes: number;
  /** 前の動画が終わった時刻。まだ1本も再生していなければ null */
  lastVideoFinishedAt: number | null;
  /** Agent（再生の仕組み）の起動時刻 */
  startedAt: number;
  /** 直近で表示時間帯が始まった時刻。表示スケジュールがなければ null */
  displayWindowStartedAt: number | null;
};

/**
 * 次に動画を始める時刻 = 起点 + 間隔。
 * 起点は「前の動画の終了」「起動」「表示時間帯の開始」のうち最も遅いもの。
 * 単位は引数と同じ（UNIX 秒でも単調増加時計の秒でもよい）。
 */
export function computeNextVideoAt(input: NextVideoInput): number {
  const anchor = Math.max(
    input.startedAt,
    input.lastVideoFinishedAt ?? -Infinity,
    input.displayWindowStartedAt ?? -Infinity,
  );
  return anchor + input.intervalMinutes * 60;
}
