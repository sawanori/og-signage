/**
 * /dev/dashboard の固定データ（本番データではない）。モック image/dashboard.png の表示を再現する。
 * 現在時刻は 2025-09-24(水) 17:42 JST。写真はモックから切り出した public/fixtures/dashboard/ のもの。
 */
import type { DashboardData, DashboardEvent, ShellData } from "@/components/admin/dashboard-types";
import type { Role } from "@/lib/auth";
import { tokyoDateTime } from "@/lib/dates";
import { NOW, makeEvent } from "@/tests/fixtures/config.fixture";

export { NOW };

const photo = (name: string) => `/fixtures/dashboard/${name}.jpg`;

/** モックのタグの色 */
const category = {
  event: { id: "cat_event", name: "イベント", color: "#F5B83D" },
  movie: { id: "cat_movie", name: "映画", color: "#B57CFB" },
  outdoor: { id: "cat_outdoor", name: "アウトドア", color: "#7DD07C" },
  social: { id: "cat_social", name: "交流", color: "#FD7890" },
  workshop: { id: "cat_workshop", name: "ワークショップ", color: "#4197FE" },
} as const;

type EventSeed = Parameters<typeof makeEvent>[0] & { imageUrl: string | null };

function event({ imageUrl, ...seed }: EventSeed): DashboardEvent {
  return { ...makeEvent(seed), imageUrl };
}

export const fixtureEvents: DashboardEvent[] = [
  event({
    id: "evt_pizza",
    title: "Pizza Night",
    emoji: "🍕",
    location: "2F ラウンジ",
    startAt: tokyoDateTime(2025, 9, 24, 19, 30),
    endAt: tokyoDateTime(2025, 9, 24, 21, 30),
    category: category.event,
    participation: "limited",
    participantCount: 12,
    capacity: 20,
    imageUrl: photo("evt-pizza"),
  }),
  event({
    id: "evt_movie",
    title: "Movie Night",
    location: "2F ラウンジ",
    startAt: tokyoDateTime(2025, 9, 26, 20, 0),
    endAt: tokyoDateTime(2025, 9, 26, 22, 0),
    category: category.movie,
    participation: "limited",
    participantCount: 8,
    capacity: 15,
    imageUrl: photo("evt-movie"),
  }),
  event({
    id: "evt_bbq",
    title: "BBQ Party",
    location: "屋上テラス",
    startAt: tokyoDateTime(2025, 9, 27, 15, 0),
    endAt: tokyoDateTime(2025, 9, 27, 20, 0),
    category: category.outdoor,
    participation: "limited",
    participantCount: 6,
    capacity: 20,
    imageUrl: photo("evt-bbq"),
  }),
  event({
    id: "evt_english",
    title: "English Meetup",
    location: "2F ラウンジ",
    startAt: tokyoDateTime(2025, 9, 30, 20, 0),
    endAt: tokyoDateTime(2025, 9, 30, 21, 30),
    category: category.social,
    participation: "limited",
    participantCount: 4,
    capacity: 15,
    imageUrl: photo("evt-english"),
  }),
  event({
    id: "evt_coffee",
    title: "コーヒーの淹れ方講座",
    location: "1F キッチン",
    startAt: tokyoDateTime(2025, 10, 3, 19, 0),
    endAt: tokyoDateTime(2025, 10, 3, 20, 30),
    category: category.workshop,
    participation: "limited",
    participantCount: 3,
    capacity: 12,
    imageUrl: photo("evt-coffee"),
  }),
];

export function fixtureShell(role: Role): ShellData {
  return {
    user: { name: "Saki", role, avatarUrl: photo("avatar") },
    alerts: [],
    sidebarImageUrl: photo("sidebar-plant"),
  };
}

const LAST_SEEN = NOW - 20;

export const fixtureDashboard: DashboardData = {
  now: NOW,
  events: fixtureEvents,
  video: {
    deviceId: "dev_entrance",
    revision: 0,
    enabled: true,
    intervalMinutes: 10,
    mode: "sequence",
    volume: 0,
    videos: [
      { mediaId: "med_welcome", name: "Welcome to Harmony House", durationSeconds: 30, thumbnailUrl: photo("vid-welcome") },
      { mediaId: "med_house", name: "ハウス紹介ムービー", durationSeconds: 60, thumbnailUrl: photo("vid-house") },
      { mediaId: "med_event_info", name: "イベント告知", durationSeconds: 45, thumbnailUrl: photo("vid-notice") },
    ],
    nextVideoAt: tokyoDateTime(2025, 9, 24, 17, 50),
    observedAt: LAST_SEEN,
  },
  notice: {
    id: "ntc_cleaning",
    title: "共用部の清掃にご協力ください",
    body: "共用部の清掃にご協力ください！\nみんなで心地よい空間をつくりましょう。\n😊",
    imageMediaId: null,
    enabled: true,
    displayMode: "always",
    displayStartTime: null,
    displayEndTime: null,
    revision: 0,
  },
  device: { id: "dev_entrance", name: "エントランス（1F）", status: "online", lastSeenAt: LAST_SEEN },
};

/** 空状態（イベント 0 件・端末未登録・お知らせなし） */
export const emptyDashboard: DashboardData = { now: NOW, events: [], video: null, notice: null, device: null };
