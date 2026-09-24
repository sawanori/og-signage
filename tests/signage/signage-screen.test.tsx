// @vitest-environment jsdom
/**
 * 表示画面の状態ごとの描画（実装計画 8.3 節）。固定日時 2025-09-24(水) 17:42 JST。
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SignageScreen } from "@/components/signage/SignageScreen";
import { WEWORK_LOGO_DARK_SRC } from "@/components/signage/wework-logo";
import type { MediaRef, SignageConfig } from "@/lib/config-schema";
import { tokyoDateTime } from "@/lib/dates";
import { HERO_SLIDE_SECONDS, heroSlideIndex, selectHeroSlides } from "@/lib/display-rules";
import { NOW, makeConfig, movieNight, pizzaNight } from "../fixtures/config.fixture";

const resolve = (ref: MediaRef) => `/media/${ref.sha256}`;

/** 大きな欄のスライドショーが 1 枚目を出す時刻にそろえる（10 秒単位で先へ進めるだけ） */
function atFirstSlide(config: SignageConfig, now: number): number {
  const count = selectHeroSlides(config.events, now).length;
  return count <= 1 ? now : now + ((count - heroSlideIndex(now, count)) % count) * HERO_SLIDE_SECONDS;
}

/**
 * 既定では、大きな欄が 1 枚目（今日の主イベント）を出す時刻にそろえて描く。
 * スライドショーそのものを確かめるときは align: false で時刻をそのまま使う。
 */
function renderScreen(
  props: Partial<{ config: SignageConfig; now: number; timeSynced: boolean; fading: boolean; align: boolean }> = {},
  orientation: "portrait" | "landscape" = "portrait",
) {
  const config = props.config ?? makeConfig();
  const now = props.now ?? NOW;
  return render(
    <SignageScreen
      config={config}
      now={props.align === false ? now : atFirstSlide(config, now)}
      resolveMediaUrl={resolve}
      orientation={orientation}
      timeSynced={props.timeSynced}
      fading={props.fading}
      fit={false}
    />,
  );
}

afterEach(cleanup);

describe.each(["portrait", "landscape"] as const)("SignageScreen（%s）", (orientation) => {
  it("TODAY: 今日の主イベントと時計・天気を出す", () => {
    renderScreen({}, orientation);
    expect(screen.getByTestId("state-badge").textContent).toContain("TODAY");
    expect(screen.getByTestId("main-title").textContent).toContain("Pizza Night");
    expect(screen.getAllByText("17:42").length).toBeGreaterThan(0);
    expect(screen.getByTestId("weather").textContent).toContain("横浜市");
    expect(screen.getByRole("img", { name: "イベント詳細の QR コード" })).toBeTruthy();
  });

  it("ロゴ未設定なら、ヘッダーに WeWork のロゴ（組み込み）・ハウス名・EVENT INFORMATION を出す", () => {
    const config = makeConfig();
    renderScreen({ config: { ...config, house: { ...config.house, logo: null, name: "OCEAN GATE MINATOMIRAI" } } }, orientation);
    const srcs = screen.getAllByAltText("WeWork").map((img) => img.getAttribute("src"));
    expect(srcs).toContain(WEWORK_LOGO_DARK_SRC);
    expect(screen.getByText("OCEAN GATE MINATOMIRAI")).toBeTruthy();
    expect(screen.getByText("EVENT INFORMATION")).toBeTruthy();
  });

  it("天気表示時: 天気欄の近くに OpenWeatherMap の出典が出る", () => {
    renderScreen({}, orientation);
    expect(within(screen.getByTestId("weather")).getByTestId("weather-attribution").textContent).toBe(
      "Weather data © OpenWeather",
    );
  });

  it("天気なし: 出典も出さない", () => {
    const config = makeConfig();
    renderScreen({ config: { ...config, weather: null } }, orientation);
    expect(screen.queryByTestId("weather")).toBeNull();
    expect(screen.queryByTestId("weather-attribution")).toBeNull();
  });

  it("STARTING SOON: 開始 30 分前から", () => {
    renderScreen({ now: tokyoDateTime(2025, 9, 24, 19, 0) }, orientation);
    expect(screen.getByTestId("state-badge").textContent).toContain("STARTING SOON");
    expect(screen.getByTestId("state-badge").dataset.state).toBe("starting_soon");
  });

  it("NOW HAPPENING: 開始から終了まで", () => {
    renderScreen({ now: tokyoDateTime(2025, 9, 24, 20, 0) }, orientation);
    expect(screen.getByTestId("state-badge").textContent).toContain("NOW HAPPENING");
  });

  it("今日のイベントがなければ、明日以降のイベントを大きく出す（日付つき）", () => {
    const config = makeConfig();
    renderScreen({ config: { ...config, events: config.events.filter((e) => e.id !== pizzaNight.id) } }, orientation);
    expect(screen.getByTestId("state-badge").textContent).toContain("UPCOMING");
    expect(screen.getByTestId("state-badge").dataset.state).toBe("upcoming");
    expect(screen.getByTestId("main-title").textContent).toContain("Movie Night");
    expect(screen.getByText(/9月26日（金） 20:00/)).toBeTruthy();
    expect(screen.queryByTestId("no-event")).toBeNull();
    // 次のイベント（明日）も Upcoming の先頭に出す
    expect(screen.getByTestId("upcoming").firstElementChild?.textContent).toContain("Movie Night");
  });

  it("イベント 0 件: キャッチコピーと空の Upcoming", () => {
    renderScreen({ config: { ...makeConfig(), events: [] } }, orientation);
    expect(screen.getByTestId("no-event").textContent).toContain("Welcome Home!");
    expect(screen.queryByTestId("state-badge")).toBeNull();
    expect(screen.queryByTestId("hero-dots")).toBeNull();
    expect(screen.getByTestId("upcoming").textContent).toContain("予定されているイベントはありません");
  });

  it("表示時間外は黒画面だけ", () => {
    const config = makeConfig({ schedule: [{ weekday: 3, startTime: "06:00", endTime: "12:00", enabled: true }] });
    renderScreen({ config }, orientation);
    expect(screen.getByTestId("signage-off")).toBeTruthy();
    expect(screen.queryByTestId("signage-canvas")).toBeNull();
  });

  it("フェード中は黒の幕を重ねる", () => {
    renderScreen({ fading: true }, orientation);
    expect(screen.getByTestId("fade").dataset.active).toBe("true");
  });

  it("時刻未同期: 画面隅の印を出し、天気を隠し、表示時間外でも消灯しない", () => {
    const config = makeConfig({ schedule: [{ weekday: 3, startTime: "06:00", endTime: "12:00", enabled: true }] });
    renderScreen({ config, timeSynced: false }, orientation);
    expect(screen.getByRole("status", { name: "時刻未同期" })).toBeTruthy();
    expect(screen.queryByTestId("weather")).toBeNull();
    expect(screen.queryByTestId("weather-attribution")).toBeNull();
    expect(screen.getByTestId("signage-canvas")).toBeTruthy();
  });

  it("天気が 3 時間より古ければ出さない", () => {
    const config = makeConfig();
    renderScreen({ config: { ...config, weather: { ...config.weather!, fetchedAt: NOW - 3 * 3600 - 1 } } }, orientation);
    expect(screen.queryByTestId("weather")).toBeNull();
    expect(screen.queryByTestId("weather-attribution")).toBeNull();
  });

  it("画像なし: img を出さずカテゴリ色の面にする", () => {
    const config = makeConfig();
    const { container } = renderScreen(
      { config: { ...config, events: config.events.map((e) => ({ ...e, image: null })) } },
      orientation,
    );
    const noImage = container.querySelectorAll('[data-has-image="false"]');
    // 大きな枠 1 つと Upcoming の行（縦型 3 行・横型 4 行）
    expect(noImage.length).toBeGreaterThanOrEqual(orientation === "portrait" ? 4 : 5);
    for (const el of noImage) expect(el.querySelector("img")).toBeNull();
    expect((noImage[0] as HTMLElement).style.backgroundColor).not.toBe("");
  });

  it("長いタイトルは長文用の組みにし、行数制限のクラスを付ける", () => {
    const config = makeConfig();
    const long = "とても長いイベント名".repeat(8);
    renderScreen(
      { config: { ...config, events: config.events.map((e) => (e.id === pizzaNight.id ? { ...e, title: long } : e)) } },
      orientation,
    );
    const title = screen.getByTestId("main-title");
    expect(title.dataset.long).toBe("true");
    expect(title.textContent).toContain(long);
  });

  it("HTML を入れても文字として出る", () => {
    const config = makeConfig();
    const html = '<img src=x onerror="alert(1)"><b>太字</b>';
    renderScreen(
      {
        config: {
          ...config,
          events: config.events.map((e) => (e.id === pizzaNight.id ? { ...e, title: html, description: html } : e)),
          notices: config.notices.map((n) => ({ ...n, title: html, body: html })),
        },
      },
      orientation,
    );
    expect(screen.getByTestId("main-title").textContent).toContain(html);
    expect(screen.getByTestId("notice").textContent).toContain(html);
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(document.querySelector("b")).toBeNull();
  });

  it("http/https 以外の QR URL は出さない", () => {
    const config = makeConfig();
    renderScreen(
      {
        config: {
          ...config,
          events: config.events.map((e) => (e.id === pizzaNight.id ? { ...e, qrUrl: "javascript:alert(1)" } : e)),
        },
      },
      orientation,
    );
    expect(screen.queryByRole("img", { name: "イベント詳細の QR コード" })).toBeNull();
  });

  it("メンバー情報はアイコンを出さず、見出し（任意）と文言を出す", () => {
    const config = makeConfig();
    const rules = [
      { icon: "info", title: "受付", text: "お困りのことはスタッフまで" },
      { icon: "info", title: null, text: "文言だけの項目" },
    ];
    renderScreen({ config: { ...config, house: { ...config.house, rules } } }, orientation);
    expect(screen.getByText("MEMBER INFO")).toBeTruthy();
    const section = screen.getByTestId("rules");
    expect(section.children).toHaveLength(2);
    expect(section.querySelector("svg")).toBeNull();
    expect(section.children[0].textContent).toBe("受付お困りのことはスタッフまで");
    expect(section.children[1].textContent).toBe("文言だけの項目");
  });

  it("画像の URL は渡された解決関数で決める（埋め込みの WeWork のロゴを除く）", () => {
    const { container } = renderScreen({}, orientation);
    const srcs = [...container.querySelectorAll("img")].map((img) => img.getAttribute("src") ?? "");
    const media = srcs.filter((src) => !src.startsWith("data:"));
    expect(media.length).toBeGreaterThan(0);
    for (const src of media) expect(src).toMatch(/^\/media\/[0-9a-f]{64}$/);
    // 埋め込みの画像は、横型のフッター右下の WeWork のロゴだけ
    expect(srcs.length - media.length).toBe(orientation === "landscape" ? 1 : 0);
  });

  it("大きな欄は 10 秒ごとに次のイベントへ切り替わる（今日の主イベントから順に）", () => {
    const config = makeConfig();
    const start = atFirstSlide(config, NOW);
    const slides = selectHeroSlides(config.events, start);
    expect(slides.length).toBeGreaterThan(1);
    renderScreen({ now: start, align: false }, orientation);
    expect(screen.getByTestId("main-title").textContent).toContain(slides[0].event.title);
    cleanup();
    renderScreen({ now: start + HERO_SLIDE_SECONDS, align: false }, orientation);
    expect(screen.getByTestId("main-title").textContent).toContain(slides[1].event.title);
    cleanup();
    renderScreen({ now: start + slides.length * HERO_SLIDE_SECONDS, align: false }, orientation);
    expect(screen.getByTestId("main-title").textContent).toContain(slides[0].event.title);
  });

  it("何枚目かを点で出し、今の 1 枚だけ強調する", () => {
    const config = makeConfig();
    const start = atFirstSlide(config, NOW) + HERO_SLIDE_SECONDS;
    renderScreen({ now: start, align: false }, orientation);
    const dots = [...screen.getByTestId("hero-dots").querySelectorAll("span")];
    expect(dots.length).toBe(selectHeroSlides(config.events, start).length);
    expect(dots.map((d) => d.dataset.active)).toEqual(dots.map((_, i) => (i === 1 ? "true" : "false")));
  });

  it("イベントが 1 件だけなら切り替えず、点も出さない", () => {
    const config = { ...makeConfig(), events: [movieNight] };
    renderScreen({ config, align: false }, orientation);
    expect(screen.getByTestId("main-title").textContent).toContain("Movie Night");
    expect(screen.queryByTestId("hero-dots")).toBeNull();
    cleanup();
    renderScreen({ config, now: NOW + HERO_SLIDE_SECONDS, align: false }, orientation);
    expect(screen.getByTestId("main-title").textContent).toContain("Movie Night");
  });

  it("Upcoming は主イベントを除いて、横型は最大 4 件・縦型は最大 3 件", () => {
    renderScreen({}, orientation);
    const upcoming = screen.getByTestId("upcoming");
    expect(upcoming.textContent).not.toContain("Pizza Night");
    expect(upcoming.textContent).toContain("Movie Night");
    // 4 件目（コーヒーの淹れ方講座）は横型だけ。縦型は大きな枠を広げるため 3 行
    if (orientation === "landscape") expect(upcoming.textContent).toContain("コーヒーの淹れ方講座");
    else expect(upcoming.textContent).not.toContain("コーヒーの淹れ方講座");
  });
});

describe("今週の予定（横型のみ）", () => {
  it("月曜始まりの 7 日間で今日を強調する", () => {
    renderScreen({}, "landscape");
    const week = screen.getByTestId("week");
    expect(week.textContent).toMatch(/^MON22TUE23WED24/);
    expect(week.querySelector('[data-today="true"]')?.textContent).toContain("24");
  });

  it("縦型には出さない", () => {
    renderScreen({}, "portrait");
    expect(screen.queryByTestId("week")).toBeNull();
  });
});
