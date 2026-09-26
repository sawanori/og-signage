// @vitest-environment jsdom
/**
 * 表示画面の状態ごとの描画（実装計画 8.3 節）。固定日時 2025-09-24(水) 17:42 JST。
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { upcomingForecast } from "@/components/signage/model";
import { SignageScreen } from "@/components/signage/SignageScreen";
import { WEWORK_LOGO_DARK_SRC } from "@/components/signage/wework-logo";
import type { MediaRef, SignageConfig, SignageSpotlight } from "@/lib/config-schema";
import { tokyoDateTime } from "@/lib/dates";
import {
  HERO_SLIDE_SECONDS,
  heroSlideIndex,
  selectHeroSlides,
  SPOTLIGHT_OFFSET_SECONDS,
  SPOTLIGHT_SLIDE_SECONDS,
} from "@/lib/display-rules";
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
    // 大きな欄の 1 枚目にそろえた分（最大で 1 枚の長さ × (枚数 − 1) 秒）だけ時計が進む
    const aligned = atFirstSlide(makeConfig(), NOW);
    expect(screen.getAllByText(aligned - NOW >= 60 ? "17:43" : "17:42").length).toBeGreaterThan(0);
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

  it("横型の右下の WeWork のロゴには、全画面の切り替えの印を付ける（公開のページだけが使う）", () => {
    renderScreen({}, orientation);
    const marked = document.querySelectorAll("[data-fullscreen-toggle]");
    if (orientation === "landscape") {
      expect(marked).toHaveLength(1);
      expect(marked[0].getAttribute("alt")).toBe("WeWork");
    } else {
      expect(marked).toHaveLength(0);
    }
  });

  it("動画を流しているあいだ（fading）は、サイネージの中身を隠す印を付ける（黒の上に出す部品は除く）", () => {
    renderScreen({ fading: true }, orientation);
    expect(screen.getByTestId("signage-canvas").dataset.fading).toBe("true");
    expect(screen.getByTestId("fade").dataset.active).toBe("true");
    cleanup();
    renderScreen({ fading: false }, orientation);
    expect(screen.getByTestId("signage-canvas").dataset.fading).toBe("false");
  });

  it("予報があれば、天気の横に明日・明後日を小さく出す（今日・3 日後は出さない）", () => {
    const config = makeConfig();
    const forecast = [
      { date: "2025-09-24", condition: "clear", maxC: 31, minC: 26, pop: 0 },
      { date: "2025-09-25", condition: "rain", maxC: 24.4, minC: 19.6, pop: 0.8 },
      { date: "2025-09-26", condition: "clouds", maxC: 27, minC: 20, pop: 0.2 },
      { date: "2025-09-27", condition: "clear", maxC: 29, minC: 22, pop: null },
    ];
    renderScreen({ config: { ...config, weather: { ...config.weather!, forecast } } }, orientation);
    const days = screen.getByTestId("forecast").children;
    expect([...days].map((d) => d.textContent)).toEqual(["明日24°/20°", "明後日27°/20°"]);
  });

  it("予報が無ければ（古い config）、予報の欄を出さない", () => {
    renderScreen({}, orientation);
    expect(screen.getByTestId("weather")).toBeTruthy();
    expect(screen.queryByTestId("forecast")).toBeNull();
  });

  it("天気なし: 出典も出さない", () => {
    const config = makeConfig();
    renderScreen({ config: { ...config, weather: null } }, orientation);
    expect(screen.queryByTestId("weather")).toBeNull();
    expect(screen.queryByTestId("weather-attribution")).toBeNull();
    expect(screen.queryByTestId("forecast")).toBeNull();
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
    const badge = screen.getByTestId("state-badge");
    expect(badge.dataset.state).toBe("upcoming");
    expect(screen.getByTestId("main-title").textContent).toContain("Movie Night");
    if (orientation === "landscape") {
      // 横型は見本（2026-09-26 ユーザー指示）どおり、丸は日付と曜日だけ。日付と時間は一覧の別の行
      expect(badge.textContent).toBe("9.26FRI");
      const hero = screen.getByTestId("main-title").parentElement!;
      expect([...hero.querySelectorAll("li")].map((li) => li.textContent)).toEqual([
        "9月26日（金）",
        "20:00 - 22:00",
        "1F シアタールーム",
        "参加自由（予約不要）",
      ]);
    } else {
      expect(badge.textContent).toContain("UPCOMING");
      expect(screen.getByText(/9月26日（金） 20:00/)).toBeTruthy();
    }
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

  it("天気が 3 時間より古ければ出さない（予報も）", () => {
    const config = makeConfig();
    const forecast = [{ date: "2025-09-25", condition: "rain", maxC: 24, minC: 20, pop: 0.8 }];
    renderScreen({ config: { ...config, weather: { ...config.weather!, fetchedAt: NOW - 3 * 3600 - 1, forecast } } }, orientation);
    expect(screen.queryByTestId("weather")).toBeNull();
    expect(screen.queryByTestId("weather-attribution")).toBeNull();
    expect(screen.queryByTestId("forecast")).toBeNull();
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
    // 横型は文字数で 3 段階の大きさ（10 文字までが見本の大きさ）。縦型は長文用の組み
    if (orientation === "landscape") expect(title.dataset.size).toBe("s");
    else expect(title.dataset.long).toBe("true");
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

  it("フッターはキャッチコピー（引用符なし）と QR。URL が未設定なら QR の場所に枠だけを出す", () => {
    const config = makeConfig();
    const house = { ...config.house, footerCopy: "会議室予約はここから", footerQrUrl: null };
    renderScreen({ config: { ...config, house } }, orientation);
    expect(screen.getByText("会議室予約はここから").textContent).toBe("会議室予約はここから");
    expect(screen.getByTestId("footer-qr").dataset.empty).toBe("true");
    expect(screen.getByTestId("footer-qr").querySelector("svg")).toBeNull();
    cleanup();
    renderScreen({ config: { ...config, house: { ...house, footerQrUrl: "https://example.com/rooms" } } }, orientation);
    expect(screen.getByTestId("footer-qr").dataset.empty).toBe("false");
    expect(screen.getByLabelText("フッターの QR コード")).toBeTruthy();
  });

  it("お知らせの QR（任意）は、http/https の URL のときだけカードの右に出す（2026-09-25 ユーザー指示）", () => {
    const config = makeConfig();
    const withQr = (qrUrl: string | null) => ({ ...config, notices: config.notices.map((n) => ({ ...n, qrUrl })) });
    renderScreen({ config: withQr("https://example.com/power") }, orientation);
    const notice = screen.getByTestId("notice");
    expect(within(notice).getByRole("img", { name: "お知らせの QR コード" })).toBeTruthy();
    // サムネイル・タイトル・詳細はそのまま
    expect(notice.querySelector("img")).toBeTruthy();
    expect(notice.textContent).toContain("共用部の清掃にご協力ください");
    cleanup();
    for (const qrUrl of [null, "javascript:alert(1)"]) {
      renderScreen({ config: withQr(qrUrl) }, orientation);
      expect(within(screen.getByTestId("notice")).queryByRole("img", { name: "お知らせの QR コード" })).toBeNull();
      cleanup();
    }
  });

  it("お知らせは横型では右の列の一番下、縦型では下段に出す。無いときは案内を出す", () => {
    renderScreen({}, orientation);
    const notice = screen.getByTestId("notice");
    expect(notice.textContent).toContain("共用部の清掃にご協力ください");
    if (orientation === "landscape") {
      // 見出しは「重要連絡：全メンバーへのお知らせ」（2026-09-25 ユーザー指示で HOUSE NEWS から変更）
      expect(notice.textContent).toContain("重要連絡");
      expect(notice.textContent).toContain("全メンバーへのお知らせ");
      // 右上の箱はメンバー情報。キャッチコピー（ヘッダー用）は横型では出さない
      expect(screen.queryByText("Welcome Home!")).toBeNull();
    }
    cleanup();
    const config = makeConfig();
    renderScreen({ config: { ...config, notices: [] } }, orientation);
    expect(screen.getByText("現在お知らせはありません")).toBeTruthy();
  });

  it("メンバー情報はアイコンを出さず、見出し（任意）と文言を出す。今週の予定は横型からも外した", () => {
    const config = makeConfig();
    const rules = [
      { icon: "info", title: "受付", text: "お困りのことはスタッフまで" },
      { icon: "info", title: null, text: "文言だけの項目" },
    ];
    renderScreen({ config: { ...config, house: { ...config.house, rules } } }, orientation);
    expect(screen.queryByText("THIS WEEK")).toBeNull();
    if (orientation === "landscape") {
      // 横型は 2026-09-26 ユーザー指示の見本で、メンバー情報を外してメンバー紹介（MEMBER SPOTLIGHT）にした
      expect(screen.queryByText("MEMBER INFO")).toBeNull();
      expect(screen.queryByTestId("rules")).toBeNull();
      expect(screen.getByText("MEMBER SPOTLIGHT")).toBeTruthy();
      return;
    }
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

  it(`大きな欄は ${HERO_SLIDE_SECONDS} 秒ごとに次のイベントへ切り替わる（今日の主イベントから順に）`, () => {
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

  it("Upcoming は主イベントを除いて、横型は最大 5 件・縦型は最大 3 件", () => {
    const config = makeConfig();
    const extra = (id: string, day: number) => ({ ...movieNight, id, title: `追加イベント${day}`, startAt: tokyoDateTime(2025, 10, day, 19, 0) });
    const events = [...config.events, extra("ev_fifth", 10), extra("ev_sixth", 11), extra("ev_seventh", 12)];
    renderScreen({ config: { ...config, events } }, orientation);
    const upcoming = screen.getByTestId("upcoming");
    expect(upcoming.textContent).not.toContain("Pizza Night");
    expect(upcoming.textContent).toContain("Movie Night");
    // 4・5 件目（コーヒーの淹れ方講座・追加イベント10）は横型だけ。縦型は大きな枠を広げるため 3 行。6 件目からはどちらにも出ない
    expect(upcoming.children).toHaveLength(orientation === "landscape" ? 5 : 3);
    if (orientation === "landscape") expect(upcoming.textContent).toContain("追加イベント10");
    else expect(upcoming.textContent).not.toContain("コーヒーの淹れ方講座");
    expect(upcoming.textContent).not.toContain("追加イベント11");
    expect(upcoming.textContent).not.toContain("追加イベント12");
  });
});


describe("メンバー紹介（横型の右上。2026-09-26 ユーザー指示）", () => {
  const photo = { mediaId: "med_spot_photo", sha256: "a".repeat(64), size: 10 };
  const logo = { mediaId: "med_spot_logo", sha256: "b".repeat(64), size: 20 };
  const yamada: SignageSpotlight = {
    id: "sp_yamada",
    companyName: "株式会社サンプル",
    personName: "山田 陸",
    role: "プロダクトデザイナー",
    quote: "デザインの力で、事業の可能性を広げる",
    bio: "プロダクトのデザインを支援しています。",
    tags: ["UI/UX", "プロダクト開発", "デザイン組織"],
    photo,
    logo,
  };
  const sato: SignageSpotlight = {
    id: "sp_sato",
    companyName: "合同会社サンプル",
    personName: "佐藤 花",
    role: null,
    quote: null,
    bio: null,
    tags: [],
    photo: null,
    logo: null,
  };
  // 1 人目が出る時刻（切り替えは (時刻 + ずらし) ÷ 1 人の秒数 の切り捨てで決まる。2 人なので 2 人分の周期で見る）
  const first = NOW - ((NOW + SPOTLIGHT_OFFSET_SECONDS) % (2 * SPOTLIGHT_SLIDE_SECONDS));
  const config = { ...makeConfig(), spotlights: [yamada, sato] };

  it("会社名・お名前「さん」・肩書き・紹介文・タグ・写真・ロゴを、省略せずに出す。左右の矢印と下の点は出さない", () => {
    renderScreen({ config, now: first, align: false }, "landscape");
    const card = screen.getByTestId("spotlight");
    // ひとことは写真の上に重ねる（2026-09-27 ユーザー指示）ので、写真の欄が先
    expect(card.textContent).toBe(
      "「デザインの力で、事業の可能性を広げる」" +
        "株式会社サンプル山田 陸さんプロダクトデザイナープロダクトのデザインを支援しています。UI/UXプロダクト開発デザイン組織",
    );
    const quote = screen.getByText("「デザインの力で、事業の可能性を広げる」");
    expect(quote.parentElement?.querySelector("img")?.getAttribute("src")).toBe(`/media/${photo.sha256}`);
    expect([...card.querySelectorAll("img")].map((img) => img.getAttribute("src"))).toEqual([
      `/media/${photo.sha256}`,
      `/media/${logo.sha256}`,
    ]);
    expect(card.querySelectorAll("svg")).toHaveLength(0);
    expect(screen.queryByTestId("spotlight-dots")).toBeNull();
  });

  it(`${SPOTLIGHT_SLIDE_SECONDS} 秒ごとに次の人へ切り替わる。肩書き・ひとこと・紹介文・タグ・写真・ロゴが無い人は、その行を出さない`, () => {
    renderScreen({ config, now: first + SPOTLIGHT_SLIDE_SECONDS, align: false }, "landscape");
    const card = screen.getByTestId("spotlight");
    expect(card.textContent).toBe("合同会社サンプル佐藤 花さん");
    expect(card.querySelectorAll("img")).toHaveLength(0);
  });

  it("登録が無い（古い Worker の config を含む）ときは「準備中」とだけ出す", () => {
    renderScreen({ config: makeConfig() }, "landscape");
    expect(screen.getByTestId("spotlight").textContent).toBe("メンバー紹介は準備中です");
    expect(screen.queryByTestId("spotlight-dots")).toBeNull();
  });

  it("縦型には出さない（縦型のメンバー情報はそのまま）", () => {
    renderScreen({ config }, "portrait");
    expect(screen.queryByTestId("spotlight")).toBeNull();
    expect(screen.getByText("MEMBER INFO")).toBeTruthy();
  });

  it("Upcoming の行は 左から 日付・写真・イベント名と時間／場所・説明の書き出し。カテゴリの帯は出さない", () => {
    const base = makeConfig();
    const events = base.events.map((e) => (e.id === movieNight.id ? { ...e, description: "話題の作品を\nみんなで楽しもう" } : e));
    renderScreen({ config: { ...base, events } }, "landscape");
    const [movie, next] = [...screen.getByTestId("upcoming").children] as HTMLElement[];
    expect(movie.textContent).toContain("Movie Night");
    expect(movie.textContent).toContain("話題の作品を");
    expect(movie.textContent).not.toContain(movieNight.category!.name);
    expect(movie.dataset.hasDesc).toBe("true");
    expect(next.dataset.hasDesc).toBe("false");
  });
});

describe("upcomingForecast", () => {
  const days = [
    { date: "2025-09-25", condition: "rain", maxC: 24, minC: 20, pop: 0.8 },
    { date: "2025-09-26", condition: "clouds", maxC: 27, minC: 20, pop: 0.2 },
    { date: "2025-09-27", condition: "clear", maxC: 29, minC: 22, pop: null },
  ];

  it("今日から見た明日・明後日を選ぶ", () => {
    expect(upcomingForecast(days, NOW).map((d) => [d.label, d.forecast.date])).toEqual([
      ["明日", "2025-09-25"],
      ["明後日", "2025-09-26"],
    ]);
  });

  it("日付が変わった直後（次の取得の前）も、今日の日付で数え直す", () => {
    const justAfterMidnight = tokyoDateTime(2025, 9, 25, 0, 5);
    expect(upcomingForecast(days, justAfterMidnight).map((d) => [d.label, d.forecast.date])).toEqual([
      ["明日", "2025-09-26"],
      ["明後日", "2025-09-27"],
    ]);
  });

  it("予報が無ければ空", () => {
    expect(upcomingForecast(undefined, NOW)).toEqual([]);
  });
});
