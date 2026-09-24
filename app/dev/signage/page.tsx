/**
 * 表示ページの確認用（固定データのみ）。
 *   /dev/signage?orientation=portrait|landscape&state=<状態>
 * 状態: today（既定。モックと同じ）/ starting-soon / now-happening / next（今日のイベントなし。明日以降を流す）/ no-event / off / fade / unsynced /
 *       no-image / long
 * &fill=1 で Web 公開のサイネージと同じく、ウィンドウに合わせて横型を縦に伸ばす（fillHeight）
 * &house=wework で本番に近いヘッダー（ロゴ未設定で WeWork のロゴ・ハウス名 OCEAN GATE MINATOMIRAI）
 */
import { SignageScreen } from "@/components/signage/SignageScreen";
import type { Orientation } from "@/components/signage/model";
import type { SignageConfig } from "@/lib/config-schema";
import { tokyoDateTime } from "@/lib/dates";
import { NOW, atFirstSlide, mockConfig, mockMediaResolver } from "./mock-fixture";

export const metadata = { title: "表示ページ確認（固定データ）" };

const STATES = [
  "today",
  "starting-soon",
  "now-happening",
  "next",
  "no-event",
  "off",
  "fade",
  "unsynced",
  "no-image",
  "long",
] as const;
type State = (typeof STATES)[number];

type Scenario = { config: SignageConfig; now: number; timeSynced: boolean; fading: boolean };

function scenario(orientation: Orientation, state: State): Scenario {
  const config = mockConfig(orientation);
  const base: Scenario = { config, now: NOW, timeSynced: true, fading: false };
  switch (state) {
    case "starting-soon":
      return { ...base, now: tokyoDateTime(2025, 9, 24, 19, 10) };
    case "now-happening":
      return { ...base, now: tokyoDateTime(2025, 9, 24, 20, 0) };
    case "next":
      return { ...base, config: { ...config, events: config.events.filter((e) => e.id !== "evt_pizza") } };
    case "no-event":
      return { ...base, config: { ...config, events: [] } };
    case "off":
      return {
        ...base,
        config: { ...config, schedule: [{ weekday: 3, startTime: "06:00", endTime: "12:00", enabled: true }] },
      };
    case "fade":
      return { ...base, fading: true };
    case "unsynced":
      return { ...base, timeSynced: false };
    case "no-image":
      return {
        ...base,
        config: {
          ...config,
          events: config.events.map((e) => ({ ...e, image: null })),
          notices: config.notices.map((n) => ({ ...n, image: null })),
        },
      };
    case "long":
      return {
        ...base,
        config: {
          ...config,
          events: config.events.map((e) =>
            e.id === "evt_pizza"
              ? {
                  ...e,
                  title: "秋の夜長のスペシャルピザパーティーと映画上映会・持ち寄りデザート交換会つき",
                  description:
                    "みんなでピザを食べながらゆるく交流しましょう！初めての方も大歓迎です！飲み物は各自でご用意ください。デザートの持ち寄りも歓迎します。片付けまでご協力をお願いします。",
                }
              : { ...e, title: `${e.title}（とても長い名前のイベントの例です）` },
          ),
          notices: config.notices.map((n) => ({
            ...n,
            title: "共用部の清掃にご協力ください。とくにキッチンとお風呂場の使い方について",
            body: "快適に過ごせる環境づくりのため、みなさんのご協力をお願いします。使ったものは元の場所へ戻し、キッチンは使用後に拭き取りをお願いします。",
          })),
        },
      };
    default:
      return base;
  }
}

export default async function DevSignagePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const orientation: Orientation = params.orientation === "landscape" ? "landscape" : "portrait";
  const state = (STATES as readonly string[]).includes(String(params.state)) ? (params.state as State) : "today";
  const s = scenario(orientation, state);
  const config =
    params.house === "wework"
      ? { ...s.config, house: { ...s.config.house, logo: null, name: "OCEAN GATE MINATOMIRAI" } }
      : s.config;
  return (
    <SignageScreen
      config={config}
      now={atFirstSlide(s.config.events, s.now)}
      resolveMediaUrl={mockMediaResolver(orientation)}
      orientation={orientation}
      timeSynced={s.timeSynced}
      fading={s.fading}
      fillHeight={params.fill === "1"}
    />
  );
}
