import { describe, expect, it } from "vitest";
import { collectMediaRefs, signageConfigSchema, type ScheduleEntry, type SignageNotice } from "../../lib/config-schema";
import { tokyoDateTime } from "../../lib/dates";
import {
  computeNextVideoAt,
  effectiveEndAt,
  getEventState,
  HERO_SLIDE_SECONDS,
  heroSlideIndex,
  isWithinDisplaySchedule,
  selectHeroSlides,
  selectMainEvent,
  selectNotice,
  selectThisWeek,
  selectUpcomingEvents,
  shouldShowWeather,
} from "../../lib/display-rules";
import {
  NOW,
  bbqParty,
  cleaningNotice,
  coffeeWorkshop,
  englishMeetup,
  makeConfig,
  makeEvent,
  mockEvents,
  movieNight,
  pizzaNight,
} from "../fixtures/config.fixture";

const at = (h: number, m: number, s = 0) => tokyoDateTime(2025, 9, 24, h, m, s);

describe("fixture と config スキーマ", () => {
  it("モックの config がスキーマを通る", () => {
    expect(signageConfigSchema.safeParse(makeConfig()).success).toBe(true);
  });

  it("URL を持たず、画像は mediaId と sha256 で参照する", () => {
    const parsed = signageConfigSchema.parse({
      ...makeConfig(),
      events: [{ ...pizzaNight, imageUrl: "https://example.com/x.jpg" }],
    });
    expect(parsed.events[0]).not.toHaveProperty("imageUrl");
    expect(parsed.events[0].image).toEqual(pizzaNight.image);
  });

  it("schemaVersion が 1 以外は拒否する", () => {
    expect(signageConfigSchema.safeParse({ ...makeConfig(), schemaVersion: 2 }).success).toBe(false);
  });

  it("collectMediaRefs は画像と動画を重複なく列挙する", () => {
    const config = makeConfig({
      notices: [{ ...cleaningNotice, image: pizzaNight.image }],
    });
    const refs = collectMediaRefs(config);
    const ids = refs.map((r) => r.mediaId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual([
      "med_logo",
      "med_footer",
      "med_pizza",
      "med_movie",
      "med_bbq",
      "med_english",
      "med_welcome",
      "med_rules_movie",
    ]);
    expect(refs.find((r) => r.mediaId === "med_welcome")).toEqual({
      mediaId: "med_welcome",
      sha256: config.playlist[0].sha256,
      size: 50_000_000,
      kind: "video",
    });
    expect(refs.find((r) => r.mediaId === "med_pizza")?.kind).toBe("image");
  });
});

describe("イベントの状態", () => {
  it("17:42 の Pizza Night（19:30 開始）は TODAY", () => {
    expect(getEventState(pizzaNight, NOW)).toBe("today");
  });

  it("開始 30 分前ちょうどから STARTING SOON、その 1 秒前は TODAY", () => {
    expect(getEventState(pizzaNight, at(18, 59, 59))).toBe("today");
    expect(getEventState(pizzaNight, at(19, 0))).toBe("starting_soon");
    expect(getEventState(pizzaNight, at(19, 29, 59))).toBe("starting_soon");
  });

  it("開始から終了時刻ちょうどまで NOW HAPPENING、その後は終了", () => {
    expect(getEventState(pizzaNight, at(19, 30))).toBe("now_happening");
    expect(getEventState(pizzaNight, at(21, 30))).toBe("now_happening");
    expect(getEventState(pizzaNight, at(21, 30, 1))).toBe("ended");
  });

  it("明日以降は upcoming", () => {
    expect(getEventState(movieNight, NOW)).toBe("upcoming");
  });

  it("終了なしは当日 23:59:59 まで開催中", () => {
    const noEnd = makeEvent({ id: "no_end", startAt: at(18, 0), endAt: null });
    expect(effectiveEndAt(noEnd)).toBe(at(23, 59, 59));
    expect(getEventState(noEnd, at(23, 59, 59))).toBe("now_happening");
    expect(getEventState(noEnd, tokyoDateTime(2025, 9, 25, 0, 0))).toBe("ended");
  });

  it("日またぎ（23:00〜翌 1:00）は翌 0:30 も開催中", () => {
    const late = makeEvent({ id: "late", startAt: at(23, 0), endAt: tokyoDateTime(2025, 9, 25, 1, 0) });
    expect(getEventState(late, at(22, 30))).toBe("starting_soon");
    expect(getEventState(late, tokyoDateTime(2025, 9, 25, 0, 30))).toBe("now_happening");
    expect(getEventState(late, tokyoDateTime(2025, 9, 25, 1, 0, 1))).toBe("ended");
  });
});

describe("今日の主イベントと Upcoming", () => {
  it("モックの状態: 主イベントは Pizza Night、Upcoming は 4 件", () => {
    const main = selectMainEvent(mockEvents, NOW);
    expect(main).toEqual({ kind: "today", event: pizzaNight, state: "today" });
    expect(selectUpcomingEvents(mockEvents, NOW, main).map((e) => e.id)).toEqual([
      movieNight.id,
      bbqParty.id,
      englishMeetup.id,
      coffeeWorkshop.id,
    ]);
  });

  it("Upcoming は最大 6 件（2026-09-25 ユーザー指示で 4 → 5 → 6）", () => {
    const fifth = makeEvent({ id: "fifth", startAt: tokyoDateTime(2025, 10, 10, 19, 0) });
    const sixth = makeEvent({ id: "sixth", startAt: tokyoDateTime(2025, 10, 11, 19, 0) });
    const seventh = makeEvent({ id: "seventh", startAt: tokyoDateTime(2025, 10, 12, 19, 0) });
    const events = [...mockEvents, seventh, sixth, fifth];
    const main = selectMainEvent(events, NOW);
    expect(selectUpcomingEvents(events, NOW, main).map((e) => e.id)).toEqual([
      movieNight.id,
      bbqParty.id,
      englishMeetup.id,
      coffeeWorkshop.id,
      "fifth",
      "sixth",
    ]);
  });

  it("下書きは主イベントにも Upcoming にも今週にも出ない", () => {
    const draftToday = makeEvent({ id: "draft_today", status: "draft", startAt: at(18, 0) });
    const draftLater = makeEvent({ id: "draft_later", status: "draft", startAt: tokyoDateTime(2025, 9, 25, 12, 0) });
    const events = [draftToday, draftLater, ...mockEvents];
    const main = selectMainEvent(events, NOW);
    expect(main.kind === "today" && main.event.id).toBe(pizzaNight.id);
    expect(selectUpcomingEvents(events, NOW, main).map((e) => e.id)).not.toContain("draft_later");
    const week = selectThisWeek(events, NOW).flatMap((d) => d.events.map((e) => e.id));
    expect(week).not.toContain("draft_today");
    expect(week).not.toContain("draft_later");
  });

  it("開催中を今日これから始まるものより優先する", () => {
    const happening = makeEvent({ id: "happening", startAt: at(17, 0), endAt: at(18, 0) });
    const main = selectMainEvent([pizzaNight, happening], NOW);
    expect(main).toEqual({ kind: "today", event: happening, state: "now_happening" });
    // 今日のうち主イベントより後のものは Upcoming に入る
    expect(selectUpcomingEvents([pizzaNight, happening], NOW, main).map((e) => e.id)).toEqual([pizzaNight.id]);
  });

  it("同時刻の 2 件は作成が早い方が主イベント、もう一方は Upcoming の先頭", () => {
    const early = makeEvent({ id: "b_early", startAt: at(19, 30), createdAt: at(9, 0) });
    const late = makeEvent({ id: "a_late", startAt: at(19, 30), createdAt: at(10, 0) });
    const main = selectMainEvent([late, early, movieNight], NOW);
    expect(main.kind === "today" && main.event.id).toBe("b_early");
    expect(selectUpcomingEvents([late, early, movieNight], NOW, main).map((e) => e.id)).toEqual([
      "a_late",
      movieNight.id,
    ]);
  });

  it("同時刻に開催中の 2 件も、主でない方は Upcoming に残る", () => {
    const a = makeEvent({ id: "a", startAt: at(17, 0), endAt: at(19, 0), createdAt: at(8, 0) });
    const b = makeEvent({ id: "b", startAt: at(17, 0), endAt: at(19, 0), createdAt: at(9, 0) });
    const main = selectMainEvent([b, a], NOW);
    expect(main.kind === "today" && main.event.id).toBe("a");
    expect(selectUpcomingEvents([b, a], NOW, main).map((e) => e.id)).toEqual(["b"]);
  });

  it("前日 23:00〜翌 1:00 の日またぎイベントは翌 0:30 に今日の主イベント", () => {
    const late = makeEvent({ id: "late", startAt: at(23, 0), endAt: tokyoDateTime(2025, 9, 25, 1, 0) });
    const main = selectMainEvent([late, movieNight], tokyoDateTime(2025, 9, 25, 0, 30));
    expect(main).toEqual({ kind: "today", event: late, state: "now_happening" });
  });

  it("開始 30 分前の主イベントは STARTING SOON", () => {
    const main = selectMainEvent(mockEvents, at(19, 0));
    expect(main).toEqual({ kind: "today", event: pizzaNight, state: "starting_soon" });
  });

  it("終了後は今日のイベントがなくなり、次のイベントを出す", () => {
    const main = selectMainEvent(mockEvents, at(21, 30, 1));
    expect(main).toEqual({ kind: "next", event: movieNight });
    expect(selectUpcomingEvents(mockEvents, at(21, 30, 1), main).map((e) => e.id)).toEqual([
      bbqParty.id,
      englishMeetup.id,
      coffeeWorkshop.id,
    ]);
  });

  it("イベント 0 件なら none（ハウスのキャッチコピーを出す）で Upcoming も空", () => {
    const main = selectMainEvent([], NOW);
    expect(main).toEqual({ kind: "none" });
    expect(selectUpcomingEvents([], NOW, main)).toEqual([]);
  });

  it("公開イベントがすべて終わっていれば none", () => {
    expect(selectMainEvent([pizzaNight], tokyoDateTime(2025, 9, 25, 9, 0))).toEqual({ kind: "none" });
  });
});

describe("大きな欄のスライドショー", () => {
  it("終わっていない公開イベントを、開催中を先頭に、残りは開始が早い順で流す", () => {
    const draft = makeEvent({ id: "evt_draft", startAt: at(21, 0), status: "draft" });
    const ended = makeEvent({ id: "evt_ended", startAt: at(9, 0), endAt: at(10, 0) });
    const events = [coffeeWorkshop, movieNight, draft, ended, pizzaNight, bbqParty, englishMeetup];
    const slides = selectHeroSlides(events, at(20, 0));
    expect(slides.map((s) => s.event.id)).toEqual([pizzaNight.id, movieNight.id, bbqParty.id, englishMeetup.id, coffeeWorkshop.id]);
    expect(slides.map((s) => s.state)).toEqual(["now_happening", "upcoming", "upcoming", "upcoming", "upcoming"]);
  });

  it("今日のイベントは、開始前なら today・30 分前から starting_soon", () => {
    expect(selectHeroSlides([pizzaNight], at(17, 42))[0].state).toBe("today");
    expect(selectHeroSlides([pizzaNight], at(19, 0))[0].state).toBe("starting_soon");
  });

  it("流すイベントが無ければ空", () => {
    expect(selectHeroSlides([], NOW)).toEqual([]);
  });

  it(`${HERO_SLIDE_SECONDS} 秒ごとに次の 1 枚へ進み、最後の次は最初に戻る`, () => {
    const H = HERO_SLIDE_SECONDS;
    const t = 1_000_000_000 - (1_000_000_000 % H); // 1 枚の切れ目
    expect(heroSlideIndex(t, 3)).toBe((t / H) % 3);
    expect(heroSlideIndex(t + H - 1, 3)).toBe(heroSlideIndex(t, 3));
    expect(heroSlideIndex(t + H, 3)).toBe((heroSlideIndex(t, 3) + 1) % 3);
    expect(heroSlideIndex(t + 3 * H, 3)).toBe(heroSlideIndex(t, 3));
  });

  it("0 件・1 件なら常に 0", () => {
    expect(heroSlideIndex(NOW, 0)).toBe(0);
    expect(heroSlideIndex(NOW + 12345, 1)).toBe(0);
  });
});

describe("今週の予定", () => {
  it("月曜始まりの 7 日間でイベントのある日を返す", () => {
    const week = selectThisWeek(mockEvents, NOW);
    expect(week.map((d) => d.dateKey)).toEqual([
      "2025-09-22",
      "2025-09-23",
      "2025-09-24",
      "2025-09-25",
      "2025-09-26",
      "2025-09-27",
      "2025-09-28",
    ]);
    expect(week.map((d) => d.weekday)).toEqual([1, 2, 3, 4, 5, 6, 0]);
    expect(week.find((d) => d.isToday)?.dateKey).toBe("2025-09-24");
    expect(week.map((d) => d.events.map((e) => e.id))).toEqual([
      [],
      [],
      [pizzaNight.id],
      [],
      [movieNight.id],
      [bbqParty.id],
      [],
    ]);
  });

  it("日曜 0:30 JST（UTC では土曜）でも同じ週", () => {
    const week = selectThisWeek(mockEvents, tokyoDateTime(2025, 9, 28, 0, 30));
    expect(week[0].dateKey).toBe("2025-09-22");
    expect(week[6].isToday).toBe(true);
  });
});

describe("お知らせ", () => {
  const timed = (overrides: Partial<SignageNotice>): SignageNotice => ({
    ...cleaningNotice,
    displayMode: "timeRange",
    ...overrides,
  });

  it("有効なお知らせを出す", () => {
    expect(selectNotice([cleaningNotice], NOW)).toBe(cleaningNotice);
  });

  it("無効なものは出さない", () => {
    expect(selectNotice([{ ...cleaningNotice, enabled: false }], NOW)).toBeNull();
  });

  it("時間帯の外は出さない（開始含む・終了含まない）", () => {
    const n = timed({ displayStartTime: "18:00", displayEndTime: "22:00" });
    expect(selectNotice([n], NOW)).toBeNull();
    expect(selectNotice([n], at(18, 0))).toBe(n);
    expect(selectNotice([n], at(22, 0))).toBeNull();
  });

  it("日またぎの時間帯（22:00〜翌 6:00）", () => {
    const n = timed({ displayStartTime: "22:00", displayEndTime: "06:00" });
    expect(selectNotice([n], at(23, 0))).toBe(n);
    expect(selectNotice([n], tokyoDateTime(2025, 9, 25, 5, 59))).toBe(n);
    expect(selectNotice([n], tokyoDateTime(2025, 9, 25, 6, 0))).toBeNull();
  });

  it("複数あれば更新が新しい 1 件", () => {
    const newer = { ...cleaningNotice, id: "newer", updatedAt: cleaningNotice.updatedAt + 60 };
    const newerButDisabled = { ...cleaningNotice, id: "disabled", enabled: false, updatedAt: NOW };
    expect(selectNotice([cleaningNotice, newer, newerButDisabled], NOW)?.id).toBe("newer");
  });
});

describe("表示スケジュール", () => {
  const entry = (weekday: ScheduleEntry["weekday"], startTime: string, endTime: string, enabled = true) => ({
    weekday,
    startTime,
    endTime,
    enabled,
  });

  it("未設定なら終日表示", () => {
    expect(isWithinDisplaySchedule([], NOW, true)).toBe(true);
    expect(isWithinDisplaySchedule([], tokyoDateTime(2025, 9, 24, 3, 0), true)).toBe(true);
  });

  it("設定した曜日は時間帯だけ表示（開始含む・終了含まない）", () => {
    const s = [entry(3, "09:00", "18:00")];
    expect(isWithinDisplaySchedule(s, at(8, 59), true)).toBe(false);
    expect(isWithinDisplaySchedule(s, at(9, 0), true)).toBe(true);
    expect(isWithinDisplaySchedule(s, NOW, true)).toBe(true);
    expect(isWithinDisplaySchedule(s, at(18, 0), true)).toBe(false);
  });

  it("未設定の曜日は終日表示（木曜は未設定）", () => {
    const s = [entry(3, "09:00", "18:00")];
    expect(isWithinDisplaySchedule(s, tokyoDateTime(2025, 9, 25, 3, 0), true)).toBe(true);
  });

  it("日またぎ（水曜 22:00〜翌 6:00）は木曜早朝も表示し、水曜の早朝は表示しない", () => {
    const s = [entry(3, "22:00", "06:00"), entry(4, "22:00", "06:00")];
    expect(isWithinDisplaySchedule(s, at(21, 59), true)).toBe(false);
    expect(isWithinDisplaySchedule(s, at(22, 0), true)).toBe(true);
    expect(isWithinDisplaySchedule(s, tokyoDateTime(2025, 9, 25, 5, 59), true)).toBe(true);
    expect(isWithinDisplaySchedule(s, tokyoDateTime(2025, 9, 25, 6, 0), true)).toBe(false);
    // 火曜は未設定なので、水曜 3:00 は火曜の続きではなく水曜の設定で判定する
    expect(isWithinDisplaySchedule(s, at(3, 0), true)).toBe(false);
  });

  it("前日の日またぎ分は、翌日が非表示設定でも表示する", () => {
    const s = [entry(3, "22:00", "02:00"), entry(4, "10:00", "20:00", false)];
    expect(isWithinDisplaySchedule(s, tokyoDateTime(2025, 9, 25, 1, 0), true)).toBe(true);
    expect(isWithinDisplaySchedule(s, tokyoDateTime(2025, 9, 25, 2, 0), true)).toBe(false);
    expect(isWithinDisplaySchedule(s, tokyoDateTime(2025, 9, 25, 12, 0), true)).toBe(false);
  });

  it("日本時間 0:00〜8:59 は日本の曜日で判定する（UTC では前日）", () => {
    // 木曜 7:00 JST = 水曜 22:00 UTC。木曜の設定 07:00〜09:00 で表示
    const s = [entry(4, "07:00", "09:00"), entry(3, "20:00", "21:00")];
    expect(isWithinDisplaySchedule(s, tokyoDateTime(2025, 9, 25, 7, 0), true)).toBe(true);
    expect(isWithinDisplaySchedule(s, tokyoDateTime(2025, 9, 25, 6, 59), true)).toBe(false);
  });

  it("時刻未同期なら消灯しない", () => {
    const s = [entry(3, "09:00", "10:00")];
    expect(isWithinDisplaySchedule(s, NOW, false)).toBe(true);
  });
});

describe("天気", () => {
  const weather = makeConfig().weather!;

  it("3 時間以内なら出す", () => {
    expect(shouldShowWeather({ ...weather, fetchedAt: NOW - 3 * 3600 }, NOW, true)).toBe(true);
  });

  it("3 時間より古ければ出さない", () => {
    expect(shouldShowWeather({ ...weather, fetchedAt: NOW - 3 * 3600 - 1 }, NOW, true)).toBe(false);
  });

  it("時刻未同期なら出さない", () => {
    expect(shouldShowWeather(weather, NOW, false)).toBe(false);
  });

  it("天気がなければ出さない", () => {
    expect(shouldShowWeather(null, NOW, true)).toBe(false);
  });
});

describe("次回の動画時刻", () => {
  it("前の動画の終了 + 間隔", () => {
    expect(
      computeNextVideoAt({
        intervalMinutes: 10,
        lastVideoFinishedAt: at(17, 30),
        startedAt: at(8, 0),
        displayWindowStartedAt: null,
      }),
    ).toBe(at(17, 40));
  });

  it("起動直後は起動時刻から数える（起動前の再生記録は使わない）", () => {
    expect(
      computeNextVideoAt({
        intervalMinutes: 15,
        lastVideoFinishedAt: at(17, 0),
        startedAt: NOW,
        displayWindowStartedAt: null,
      }),
    ).toBe(at(17, 57));
    expect(
      computeNextVideoAt({ intervalMinutes: 5, lastVideoFinishedAt: null, startedAt: NOW, displayWindowStartedAt: null }),
    ).toBe(at(17, 47));
  });

  it("表示時間帯の開始直後はその時刻から数える", () => {
    expect(
      computeNextVideoAt({
        intervalMinutes: 30,
        lastVideoFinishedAt: tokyoDateTime(2025, 9, 23, 21, 50),
        startedAt: tokyoDateTime(2025, 9, 20, 4, 0),
        displayWindowStartedAt: at(9, 0),
      }),
    ).toBe(at(9, 30));
  });
});
