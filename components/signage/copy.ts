/**
 * 画面に固定で出す文言（見出しとブランドの添え書き）。
 * config（SignageConfig）に項目がないため部品側に持つ。管理画面で変えられるようにする場合は
 * config-schema に項目を足してここから外す。
 */
export const COPY = {
  portraitHouseKind: "SHARE HOUSE",
  landscapeHouseKind: "SHARE LIFE, MORE POSSIBILITIES",
  portraitTagline: "Good People, Better Days.",
  landscapeTaglineScript: ["Good People", "Better Days"],
  landscapeBoxTagline: ["A SMALL COMMUNITY", "A BIGGER TOMORROW."],
  upcoming: { en: "UPCOMING EVENTS", ja: "今後のイベント" },
  seeAll: "すべて見る",
  news: { en: "HOUSE NEWS", ja: "お知らせ" },
  rules: { en: "HOUSE RULES", ja: "ハウスルール" },
  week: { en: "THIS WEEK", ja: "今週の予定" },
  detailPortrait: "詳しく見る",
  detailLandscape: "詳細はこちら",
  qrLabel: "イベント詳細",
  hostPrefix: "主催：",
  noEventsToday: "本日のイベントはありません",
  nextEvent: { en: "NEXT EVENT", ja: "次のイベント" },
  noUpcoming: "予定されているイベントはありません",
  noNotice: "現在お知らせはありません",
  offHours: "表示時間外",
} as const;
