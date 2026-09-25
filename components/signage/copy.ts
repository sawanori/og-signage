/**
 * 画面に固定で出す文言（見出しとブランドの添え書き）。
 * config（SignageConfig）に項目がないため部品側に持つ。管理画面で変えられるようにする場合は
 * config-schema に項目を足してここから外す。
 */
export const COPY = {
  // ハウス名の下の添え書き（2026-09-25 ユーザー指示で「WeWork Ocean Gate Minatomirai / Event Information」に）
  portraitHouseKind: "EVENT INFORMATION",
  landscapeHouseKind: "EVENT INFORMATION",
  // 手書き風のタグライン（2026-09-25 ユーザー指示で「Good People, Better Days」から変更）
  portraitTagline: "Do What You Love",
  landscapeTaglineScript: ["Do What", "You Love"],
  upcoming: { en: "UPCOMING EVENTS", ja: "今後のイベント" },
  // お知らせの欄の見出し。en は目立つ見出し（横型は黒い帯）、ja は添え書き（2026-09-25 ユーザー指示で
  // 「HOUSE NEWS / お知らせ」から「重要連絡：全メンバーへのお知らせ」に）
  news: { en: "重要連絡", ja: "全メンバーへのお知らせ" },
  // 旧ハウスルールの欄（2026-09-25 ユーザー指示でメンバー情報に。中身は管理画面のデザイン設定で変える）
  rules: { en: "MEMBER INFO", ja: "メンバー情報" },
  week: { en: "THIS WEEK", ja: "今週の予定" },
  qrLabel: "イベント詳細",
  hostPrefix: "主催：",
  noUpcoming: "予定されているイベントはありません",
  noNotice: "現在お知らせはありません",
  offHours: "表示時間外",
  /** OpenWeatherMap 無料プランの利用規約で必須の出典表示（docs/spikes/workers.md 項目 9） */
  weatherAttribution: "Weather data © OpenWeather",
} as const;
