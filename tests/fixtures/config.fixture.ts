/**
 * モック（image/UI-V.png・UI-H.png）の内容を再現した固定データ。
 * 現在時刻は 2025-09-24(水) 17:42 JST。
 */
import type { MediaRef, SignageConfig, SignageEvent, SignageNotice } from "../../lib/config-schema";
import { tokyoDateTime } from "../../lib/dates";

/** 2025-09-24(水) 17:42:00 JST */
export const NOW = tokyoDateTime(2025, 9, 24, 17, 42);

/** 連番から偽の sha256（小文字16進64桁）を作る */
export function fakeSha256(n: number): string {
  return n.toString(16).padStart(64, "0");
}

export function mediaRef(id: string, n: number, size = 100_000): MediaRef {
  return { mediaId: id, sha256: fakeSha256(n), size };
}

export const categories = {
  movie: { id: "cat_movie", name: "映画", color: "#7C3AED" },
  outdoor: { id: "cat_outdoor", name: "アウトドア", color: "#16A34A" },
  social: { id: "cat_social", name: "交流", color: "#F97316" },
  workshop: { id: "cat_workshop", name: "ワークショップ", color: "#0EA5E9" },
  other: { id: "cat_other", name: "その他", color: "#64748B" },
} as const;

const CREATED = tokyoDateTime(2025, 9, 1, 10, 0);

/** 最小限の項目からイベントを作る（テストで上書きして使う） */
export function makeEvent(overrides: Partial<SignageEvent> & Pick<SignageEvent, "id" | "startAt">): SignageEvent {
  return {
    status: "published",
    title: overrides.id,
    description: null,
    location: null,
    endAt: null,
    category: null,
    emoji: null,
    hostName: null,
    catchCopy: null,
    participation: "free",
    capacity: null,
    participantCount: null,
    qrUrl: null,
    image: null,
    createdAt: CREATED,
    ...overrides,
  };
}

export const pizzaNight = makeEvent({
  id: "evt_pizza",
  title: "Pizza Night",
  emoji: "🍕",
  description: "みんなでピザを焼いて食べましょう。",
  location: "2F ラウンジ",
  startAt: tokyoDateTime(2025, 9, 24, 19, 30),
  endAt: tokyoDateTime(2025, 9, 24, 21, 30),
  category: categories.social,
  hostName: "ハウススタッフ",
  catchCopy: "Good Food / Good People!",
  participation: "free",
  qrUrl: "https://example.com/events/pizza",
  image: mediaRef("med_pizza", 1),
});

export const movieNight = makeEvent({
  id: "evt_movie",
  title: "Movie Night",
  emoji: "🎬",
  location: "1F シアタールーム",
  startAt: tokyoDateTime(2025, 9, 26, 20, 0),
  endAt: tokyoDateTime(2025, 9, 26, 22, 0),
  category: categories.movie,
  image: mediaRef("med_movie", 2),
});

export const bbqParty = makeEvent({
  id: "evt_bbq",
  title: "BBQ Party",
  emoji: "🍖",
  location: "屋上テラス",
  startAt: tokyoDateTime(2025, 9, 27, 17, 0),
  endAt: tokyoDateTime(2025, 9, 27, 20, 0),
  category: categories.outdoor,
  participation: "limited",
  capacity: 20,
  participantCount: 12,
  image: mediaRef("med_bbq", 3),
});

export const englishMeetup = makeEvent({
  id: "evt_english",
  title: "English Meetup",
  emoji: "💬",
  location: "2F ラウンジ",
  startAt: tokyoDateTime(2025, 9, 30, 19, 0),
  endAt: tokyoDateTime(2025, 9, 30, 21, 0),
  category: categories.social,
  image: mediaRef("med_english", 4),
});

export const coffeeWorkshop = makeEvent({
  id: "evt_coffee",
  title: "コーヒーの淹れ方講座",
  emoji: "☕",
  location: "1F キッチン",
  startAt: tokyoDateTime(2025, 10, 3, 19, 0),
  endAt: tokyoDateTime(2025, 10, 3, 20, 30),
  category: categories.workshop,
  participation: "limited",
  capacity: 8,
  participantCount: 5,
  image: null,
});

export const mockEvents: SignageEvent[] = [pizzaNight, movieNight, bbqParty, englishMeetup, coffeeWorkshop];

export const cleaningNotice: SignageNotice = {
  id: "ntc_cleaning",
  title: "共用部の清掃にご協力ください",
  body: "使ったものは元の場所へ戻し、キッチンは使用後に拭き取りをお願いします。",
  image: mediaRef("med_notice", 5),
  enabled: true,
  displayMode: "always",
  displayStartTime: null,
  displayEndTime: null,
  updatedAt: tokyoDateTime(2025, 9, 20, 9, 0),
};

export function makeConfig(overrides: Partial<SignageConfig> = {}): SignageConfig {
  return {
    schemaVersion: 1,
    version: fakeSha256(0xc0ff1e),
    events: mockEvents,
    notices: [cleaningNotice],
    house: {
      name: "HARMONY HOUSE",
      headerCopy: "Welcome Home!",
      footerCopy: "Same House, Different Stories.",
      logo: mediaRef("med_logo", 6),
      footerImage: mediaRef("med_footer", 7),
      rules: [
        { icon: "volume-x", text: "22時以降はお静かに" },
        { icon: "trash-2", text: "ゴミは分別して出しましょう" },
        { icon: "sparkles", text: "共用部はきれいに使いましょう" },
      ],
    },
    schedule: [],
    weather: {
      locationName: "横浜市",
      temperatureC: 26,
      condition: "clear",
      fetchedAt: NOW - 10 * 60,
    },
    video: { enabled: true, intervalMinutes: 10, mode: "sequence" },
    playlist: [
      { ...mediaRef("med_welcome", 8, 50_000_000), durationSeconds: 30 },
      { ...mediaRef("med_rules_movie", 9, 40_000_000), durationSeconds: 25.5 },
    ],
    displayBundle: { id: "bundle_2025_09_24_1", sha256: fakeSha256(10), size: 2_000_000 },
    device: { orientation: "portrait", width: 1080, height: 1920, volume: 0 },
    commands: { testPlayRequestedAt: null },
    ...overrides,
  };
}
