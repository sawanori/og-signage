/**
 * 確認用ページ（/dev/signage）とモック比較で使う固定データ。本番データではない。
 *
 * tests/fixtures/config.fixture.ts を土台に、文言・時間・場所をモック（UI-V / UI-H）の表示どおりに上書きする。
 * 縦型と横型のモックはキャッチコピーやロゴ・写真が違うため、向きごとに作る。
 * 写真は tests/visual/extract-fixtures.py がモックから切り出した public/fixtures/<向き>/ のもの。
 */
import type { MediaRef, SignageConfig, SignageEvent } from "@/lib/config-schema";
import { tokyoDateTime } from "@/lib/dates";
import {
  NOW,
  bbqParty,
  cleaningNotice,
  coffeeWorkshop,
  englishMeetup,
  makeConfig,
  mediaRef,
  movieNight,
  pizzaNight,
} from "@/tests/fixtures/config.fixture";
import type { Orientation } from "@/components/signage/model";

export { NOW };

/** モックのタグの色から逆算したカテゴリ色（タグは白との混色で薄く出す） */
const category = {
  event: { id: "cat_event", name: "イベント", color: "#F7CB61" },
  movie: { id: "cat_movie", name: "映画", color: "#813EEC" },
  outdoor: { id: "cat_outdoor", name: "アウトドア", color: "#339018" },
  social: { id: "cat_social", name: "交流", color: "#E3261F" },
  workshop: { id: "cat_workshop", name: "ワークショップ", color: "#2A74F2" },
} as const;

const HOUSE_COPY: Record<Orientation, { header: string; footer: string }> = {
  portrait: {
    header: "ここで暮らす、\nちょっと特別な毎日を。",
    footer: "Same House, Different Stories.\nいろんな出会いが、\nきっと明日の自分をつくる。",
  },
  landscape: {
    header: "ここでの出会いが、\nきっと何かを変える。",
    footer: "Same House, Different Stories.\nここで過ごす日々が、きっと特別なものになる。",
  },
};

export const mockEvents: SignageEvent[] = [
  {
    ...pizzaNight,
    description: "みんなでピザを食べながらゆるく交流しましょう！\n初めての方も大歓迎です！",
    category: category.event,
    hostName: "Yuki",
  },
  // 今週の予定の絵文字はモックの絵柄（ビデオカメラ）に合わせる
  { ...movieNight, emoji: "🎥", location: "2F ラウンジ", category: category.movie },
  {
    ...bbqParty,
    startAt: tokyoDateTime(2025, 9, 27, 15, 0),
    endAt: tokyoDateTime(2025, 9, 27, 20, 0),
    category: category.outdoor,
  },
  {
    ...englishMeetup,
    startAt: tokyoDateTime(2025, 9, 30, 20, 0),
    endAt: tokyoDateTime(2025, 9, 30, 21, 30),
    category: category.social,
  },
  { ...coffeeWorkshop, category: category.workshop, image: mediaRef("med_coffee", 11) },
];

export function mockConfig(orientation: Orientation): SignageConfig {
  const base = makeConfig();
  return {
    ...base,
    events: mockEvents,
    notices: [
      {
        ...cleaningNotice,
        body: "快適に過ごせる環境づくりのため、\nみなさんのご協力をお願いします。",
      },
    ],
    house: {
      ...base.house,
      headerCopy: HOUSE_COPY[orientation].header,
      footerCopy: HOUSE_COPY[orientation].footer,
      footerImage: orientation === "portrait" ? base.house.footerImage : null,
      rules: [
        { icon: "bell-off", text: "22時以降は\nお静かに" },
        { icon: "trash-2", text: "ゴミは分別して\n捨てましょう" },
        { icon: "users", text: "お互いを尊重して\n気持ちよく" },
      ],
    },
    device: {
      ...base.device,
      orientation,
      width: orientation === "portrait" ? 1080 : 1920,
      height: orientation === "portrait" ? 1920 : 1080,
    },
  };
}

/** fixture の画像 URL（public/fixtures/<向き>/<mediaId>） */
export function mockMediaResolver(orientation: Orientation) {
  return (ref: MediaRef) => `/fixtures/${orientation}/${ref.mediaId}.${ref.mediaId === "med_logo" ? "png" : "jpg"}`;
}
