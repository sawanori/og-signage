/**
 * 確認用ページ（/dev/signage）とモック比較で使う固定データ。本番データではない。
 *
 * tests/fixtures/config.fixture.ts を土台に、文言・時間・場所をモック（UI-V / UI-H）の表示どおりに上書きする。
 * 縦型と横型のモックはキャッチコピーやロゴ・写真が違うため、向きごとに作る。
 * 写真は tests/visual/extract-fixtures.py がモックから切り出した public/fixtures/<向き>/ のもの。
 */
import type { MediaRef, SignageConfig, SignageEvent, SignageSpotlight } from "@/lib/config-schema";
import { tokyoDateTime } from "@/lib/dates";
import { HERO_SLIDE_SECONDS, heroSlideIndex, selectHeroSlides } from "@/lib/display-rules";
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

/**
 * 大きな欄のスライドショーの 1 枚目（今日のイベント）が出る時刻にそろえる。モックとの比較用。
 * 10 秒単位で先へ進めるだけなので、時計の表示（時:分）は変わらない（例: 17:42:00 → 17:42:30）。
 */
export function atFirstSlide(events: readonly SignageEvent[], now: number): number {
  const count = selectHeroSlides(events, now).length;
  if (count <= 1) return now;
  return now + ((count - heroSlideIndex(now, count)) % count) * HERO_SLIDE_SECONDS;
}

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
  // Upcoming の行の右に出る説明の書き出し（2026-09-26 ユーザー指示の見本の文面）
  {
    ...movieNight,
    emoji: "🎥",
    location: "2F ラウンジ",
    category: category.movie,
    description: "話題の作品を\nみんなで楽しもう",
  },
  {
    ...bbqParty,
    startAt: tokyoDateTime(2025, 9, 27, 15, 0),
    endAt: tokyoDateTime(2025, 9, 27, 20, 0),
    category: category.outdoor,
    description: "おいしいごはんと\n新しい出会い",
  },
  {
    ...englishMeetup,
    startAt: tokyoDateTime(2025, 9, 30, 20, 0),
    endAt: tokyoDateTime(2025, 9, 30, 21, 30),
    category: category.social,
    description: "英語で気軽に\nつながる時間",
  },
  {
    ...coffeeWorkshop,
    category: category.workshop,
    image: mediaRef("med_coffee", 11),
    description: "ハンドドリップの\n基本を学ぶ",
  },
];

/**
 * メンバー紹介（横型の右上。2026-09-26 ユーザー指示の見本の文面）。会社名とロゴは架空のもの。
 * 写真は見本の画像から切り出した public/fixtures/landscape/med_spot_photo.jpg
 */
const mockSpotlights: SignageSpotlight[] = [
  {
    id: "spot_yamada",
    companyName: "株式会社サンプル",
    personName: "山田 陸",
    role: "プロダクトデザイナー",
    quote: "デザインの力で、事業の可能性を広げる",
    bio: "プロダクト・ブランド・組織のデザイン支援を通じて、企業の成長を伴走します。",
    tags: ["UI/UX", "プロダクト開発", "デザイン組織"],
    photo: mediaRef("med_spot_photo", 21),
    logo: mediaRef("med_spot_logo", 22),
  },
  {
    id: "spot_sato",
    companyName: "オーシャンゲート合同会社",
    personName: "佐藤 花",
    role: "コミュニティマネージャー",
    quote: "人と人がつながる場をつくる",
    bio: "イベントの企画とメンバー同士の交流づくりを担当しています。",
    tags: ["コミュニティ", "イベント"],
    photo: null,
    logo: null,
  },
  {
    id: "spot_suzuki",
    companyName: "株式会社みなとテック",
    personName: "鈴木 健太",
    role: "エンジニア",
    // 1 行にわずかに入らない短いひとこと（少し小さくして 1 行で出す例）
    quote: "鈴木ケンタです。",
    bio: null,
    tags: [],
    photo: null,
    logo: null,
  },
  // 長い会社名（ローマ字入り）でも省略しない例（2026-09-26 ユーザー指示「企業名が文字数で省略されるのはあり得ない」）
  {
    id: "spot_long_latin",
    companyName: "Ocean Gate Creative合同会社",
    personName: "高橋 誠",
    role: "代表",
    quote: "ものづくりで街を明るく",
    bio: "映像とアプリの制作をしています。",
    tags: ["映像制作", "アプリ開発"],
    photo: mediaRef("med_spot_photo", 21),
    logo: null,
  },
  // ロゴつきで、どの欄も上限いっぱいの例（入りきらなければ文字の組みを小さくして全文を出す）
  {
    id: "spot_full",
    companyName: "株式会社みなとみらいクリエイティブラボラトリーズ",
    personName: "アレクサンダー・マクミラン",
    role: "チーフプロダクトオフィサー兼デザイン部門責任者",
    quote: "デザインとテクノロジーの力で、街で働く人の毎日をもっと楽しく",
    bio: "プロダクト・ブランド・組織のデザイン支援を通じて、企業の成長を伴走します。週末は写真を撮っています。",
    tags: ["プロダクトデザイン", "ブランディング", "組織デザイン"],
    photo: mediaRef("med_spot_photo", 21),
    logo: mediaRef("med_spot_logo", 22),
  },
];

export function mockConfig(orientation: Orientation): SignageConfig {
  const base = makeConfig();
  return {
    ...base,
    events: mockEvents,
    spotlights: mockSpotlights,
    notices: [
      {
        ...cleaningNotice,
        body: "快適に過ごせる環境づくりのため、\nみなさんのご協力をお願いします。",
        // お知らせの QR（任意。2026-09-25 ユーザー指示）
        qrUrl: "https://example.com/notice",
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
    // 明日・明後日の予報（天気の横に小さく出る。2026-09-25 ユーザー指示）
    weather: base.weather && {
      ...base.weather,
      forecast: [
        { date: "2025-09-25", condition: "rain", maxC: 24, minC: 20, pop: 0.8 },
        { date: "2025-09-26", condition: "clouds", maxC: 27, minC: 21, pop: 0.3 },
        { date: "2025-09-27", condition: "clear", maxC: 28, minC: 21, pop: 0.1 },
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
  return (ref: MediaRef) => `/fixtures/${orientation}/${ref.mediaId}.${ref.mediaId.endsWith("_logo") ? "png" : "jpg"}`;
}
