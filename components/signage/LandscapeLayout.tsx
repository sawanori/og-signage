/**
 * 横型（1920×1080）の配置。モック image/UI-H.png の画面部分に合わせる。
 * 2026-09-25 ユーザー指示: ヘッダーを 2/3 の高さ（92px）に。下段の欄のうち今週の予定は外し、大きな枠をフッターまで広げる。
 * 右の列は上から メンバー紹介（MEMBER SPOTLIGHT）・UPCOMING（5 件）・お知らせ（重要連絡。白いカードで縁はドロップシャドウ）。
 * 2026-09-26 ユーザー指示の見本で、メンバー情報（MEMBER INFO）を外してメンバー紹介に置き換えた（縦型のメンバー情報はそのまま）。
 * どれも同じ左端（1368px）・幅（516px）。キャッチコピー（ヘッダー用）は横型では出さない。
 */
import { Fragment } from "react";
import { ArrowRight, CalendarDays, ChevronLeft, ChevronRight, Clock } from "lucide-react";
import type { SignageConfig, SignageEvent } from "@/lib/config-schema";
import { COPY } from "./copy";
import {
  formatDateJa,
  formatMonthDay,
  formatParticipation,
  formatTimeRange,
  formatWeekdayUpper,
  splitCatchCopy,
  splitFooterCopy,
  stateLabel,
  type ResolveMediaUrl,
  type SignageView,
} from "./model";
import { Emoji, FooterQr, GroupIcon, HeroDots, isQrUrl, MediaImage, PersonIcon, PinIcon, QrCode, WeatherIcon } from "./parts";
import styles from "./signage.module.css";
import { WEWORK_LOGO_DARK_SRC, WEWORK_LOGO_SRC } from "./wework-logo";

type Props = { config: SignageConfig; view: SignageView; resolveMediaUrl: ResolveMediaUrl };

/** 1920px 基準の横位置に、横に伸ばした幅（--canvas-extra-x）の share 倍を足す（signage.module.css の横型の説明） */
const stretchX = (px: number, share: number) => `calc(${px}px + var(--canvas-extra-x, 0px) * ${share})`;

export function LandscapeLayout({ config, view, resolveMediaUrl }: Props) {
  const { house } = config;
  const footer = splitFooterCopy(house.footerCopy);
  // お知らせの QR（任意）。http/https の URL のときだけ出す
  const noticeQr = view.notice?.qrUrl ?? null;
  return (
    <div className={styles.landscape}>
      {/* ヘッダー。ロゴ｜細い縦線｜ハウス名と添え書き。ロゴ未設定なら WeWork のロゴ */}
      <div className={styles.lHeaderBand} />
      <div className={styles.lBrand}>
        {house.logo ? (
          // eslint-disable-next-line @next/next/no-img-element -- オフライン配信のため素の img
          <img src={resolveMediaUrl(house.logo)} alt="" className={styles.lLogo} />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- オフライン配信のため素の img
          <img src={WEWORK_LOGO_DARK_SRC} alt="WeWork" className={styles.lWordmark} />
        )}
        <span className={styles.lBrandRule} aria-hidden />
        <div>
          <div className={styles.lHouseName}>{house.name}</div>
          <div className={styles.lHouseKind}>{COPY.landscapeHouseKind}</div>
        </div>
      </div>
      <div className={styles.lScript} aria-hidden>
        <span>{COPY.landscapeTaglineScript[0]}</span>
        <span style={{ marginLeft: 48 }}>{COPY.landscapeTaglineScript[1]}</span>
      </div>
      <svg className={styles.lScriptLine} width="110" height="16" viewBox="0 0 110 16" aria-hidden>
        <path d="M2 13 C 34 8, 70 5, 108 4" fill="none" stroke="#1B2530" strokeWidth="2" strokeLinecap="round" />
      </svg>
      {/* メンバー紹介。右の列の一番上で、UPCOMING と同じ左端・幅・見出しの並び（2026-09-26 ユーザー指示の見本どおり） */}
      <div className={styles.lSectionTitle} style={{ left: stretchX(1372, 1), top: 38 }}>
        <span className={styles.lSectionEn}>{COPY.spotlight.en}</span>
        <span className={styles.lSectionJa}>{COPY.spotlight.ja}</span>
      </div>
      <Spotlight spotlight={view.spotlight} resolveMediaUrl={resolveMediaUrl} />

      {/* 今日のイベント */}
      <Hero hero={view.hero} config={config} resolveMediaUrl={resolveMediaUrl} />

      {/* Upcoming */}
      <div className={styles.lSectionTitle} style={{ left: stretchX(1372, 1), top: 420 }}>
        <span className={styles.lSectionEn}>{COPY.upcoming.en}</span>
        <span className={styles.lSectionJa}>{COPY.upcoming.ja}</span>
      </div>
      <div className={styles.lUpcoming} data-testid="upcoming">
        {view.upcoming.length === 0 ? <div className={styles.pEmpty}>{COPY.noUpcoming}</div> : null}
        {view.upcoming.map((event) => (
          <UpcomingRow key={event.id} event={event} resolveMediaUrl={resolveMediaUrl} />
        ))}
      </div>

      {/* お知らせとフッター。縦に伸ばしたときは、伸びた分だけ下へずらす（中の位置は 1920×1080 のまま） */}
      <div className={styles.lLower}>
        {/* お知らせ。右の列の一番下（2026-09-25 ユーザー指示。大きめの白いカードで、縁はドロップシャドウ）。
            左からサムネイル・タイトルと詳細・QR（任意。管理画面のお知らせで URL を入れたときだけ） */}
        <div className={styles.lNews} data-testid="notice">
          <div className={styles.lNewsMain}>
            <div className={styles.lNewsLabel}>
              <span className={styles.lNewsEn}>{COPY.news.en}</span>
              <span className={styles.lNewsJa}>{COPY.news.ja}</span>
            </div>
            {view.notice ? (
              <div className={styles.lNewsBody}>
                {view.notice.image ? (
                  <MediaImage media={view.notice.image} category={null} resolveMediaUrl={resolveMediaUrl} className={styles.lNewsImage} />
                ) : null}
                <div className={styles.lNewsText}>
                  <div className={styles.lNewsTitle}>{view.notice.title}</div>
                  {view.notice.body ? <div className={styles.lNewsDesc}>{view.notice.body}</div> : null}
                </div>
              </div>
            ) : (
              <div className={styles.lNewsEmpty}>{COPY.noNotice}</div>
            )}
          </div>
          {isQrUrl(noticeQr) ? (
            <div className={styles.lNewsQr}>
              <QrCode url={noticeQr} size={92} label={COPY.noticeQrLabel} />
            </div>
          ) : null}
        </div>
        {/* フッター */}
        <div className={styles.lFooter}>
          <div className={styles.lFooterTime}>{view.clock.time}</div>
          <div className={styles.lFooterDate}>
            {view.clock.year}. {view.clock.month}.{view.clock.day} ({view.clock.weekdayShort})
          </div>
          {view.weather ? (
            <div className={styles.lFooterWeather} data-testid="weather">
              <WeatherIcon condition={view.weather.condition} size={38} strokeWidth={1.7} />
              <span className={styles.lFooterTemp}>{Math.round(view.weather.temperatureC)}
              <span className={styles.deg}>°</span>C
            </span>
              <span className={styles.lFooterPlace}>{view.weather.locationName}</span>
              {/* 明日・明後日の天気を小さく（2026-09-25 ユーザー指示） */}
              {view.forecast.length > 0 ? (
                <span className={styles.lForecast} data-testid="forecast">
                  {view.forecast.map(({ label, forecast }) => (
                    <span key={forecast.date} className={styles.lForecastDay}>
                      <span className={styles.lForecastLabel}>{label}</span>
                      <WeatherIcon condition={forecast.condition} size={16} strokeWidth={2} />
                      <span>
                        {Math.round(forecast.maxC)}°/{Math.round(forecast.minC)}°
                      </span>
                    </span>
                  ))}
                </span>
              ) : null}
              <span className={styles.lWeatherAttribution} data-testid="weather-attribution">
                {COPY.weatherAttribution}
              </span>
            </div>
          ) : null}
          <div className={styles.lFooterDivider} />
          {/* キャッチコピー（フッター用。例: 会議室予約はここから）と QR。引用符は付けない（2026-09-25 ユーザー指示） */}
          <div className={styles.lFooterCopy}>
            {footer.lead || footer.sub.length > 0 ? (
              <>
                <div className={styles.lFooterText}>
                  {footer.lead ? <div className={styles.lFooterLead}>{footer.lead}</div> : null}
                  {footer.sub.length > 0 ? <div className={styles.lFooterSub}>{footer.sub.join("")}</div> : null}
                </div>
                <ArrowRight className={styles.footerArrow} size={26} strokeWidth={2} aria-hidden />
              </>
            ) : null}
            <FooterQr url={house.footerQrUrl} size={62} className={styles.lFooterQr} />
          </div>
          {/* 公開のサイネージでは、このロゴを押すと全画面表示を入れ・解除する（app/signage/fullscreen-toggle.ts） */}
          {/* eslint-disable-next-line @next/next/no-img-element -- オフライン配信のため素の img */}
          <img src={WEWORK_LOGO_SRC} alt="WeWork" className={styles.lFooterLogo} data-fullscreen-toggle="" />
        </div>
      </div>
    </div>
  );
}

function Hero({
  hero,
  config,
  resolveMediaUrl,
}: {
  hero: SignageView["hero"];
  config: SignageConfig;
  resolveMediaUrl: ResolveMediaUrl;
}) {
  if (!hero) {
    // 流すイベントが 1 件も無いとき。ハウスのキャッチコピーを出す
    const copy = config.house.headerCopy ?? config.house.name;
    return (
      <div className={`${styles.lHero} ${styles.lHeroQuiet}`} data-testid="no-event">
        <div className={styles.quietCopy}>{copy}</div>
        <div className={styles.quietNote}>{COPY.noUpcoming}</div>
      </div>
    );
  }
  const { slide, index, count } = hero;
  const { event, state } = slide;
  const label = stateLabel(state);
  const catchLines = splitCatchCopy(event.catchCopy);
  const titleLength = [...event.title].length;
  // 見本（2026-09-26 ユーザー指示）の大きさは 10 文字（2 行）まで。長いものは段階的に小さくする
  const titleSize = titleLength <= 10 ? "l" : titleLength <= 16 ? "m" : "s";
  // 写真（QR と点の並びを含む）・丸い目印・本文は別々の要素なので、同じ key でまとめて入れ替え、それぞれフェードで出す
  const fade = count > 1 ? styles.heroFade : "";
  return (
    <Fragment key={event.id}>
      <MediaImage
        media={event.image}
        category={event.category}
        resolveMediaUrl={resolveMediaUrl}
        className={`${styles.lHero} ${fade}`}
      >
        <div className={styles.lHeroShade} />
        {catchLines.length > 0 ? (
          <div className={styles.lCatch} aria-hidden>
            <span className={styles.pCatchTick1} />
            {catchLines.slice(0, 2).map((line, i) => (
              <span key={i} className={styles.lCatchLine} style={{ marginLeft: i * 30 }}>
                {line}
              </span>
            ))}
            <span className={styles.pCatchTick2} />
          </div>
        ) : null}
        <div className={`${styles.heroCorner} ${styles.lCorner}`}>
          {isQrUrl(event.qrUrl) ? (
            <div className={styles.lQr}>
              <QrCode url={event.qrUrl} size={106} />
              <span className={styles.lQrLabel}>{COPY.qrLabel}</span>
            </div>
          ) : null}
          {count > 1 ? <HeroDots index={index} count={count} /> : null}
        </div>
      </MediaImage>
      {/* 丸い目印は日付と曜日（見本どおり）。今日・まもなく・開催中のときだけ、その上に状態を添える */}
      <div className={`${styles.lCircle} ${fade}`} data-state={state} data-testid="state-badge">
        {state === "upcoming" ? null : (
          <span className={styles.lCircleEn} data-long={label.en.length > 5 ? "true" : "false"}>
            {label.en}
          </span>
        )}
        <span className={styles.lCircleDate}>{formatMonthDay(event.startAt)}</span>
        <span className={styles.lCircleWeek}>{formatWeekdayUpper(event.startAt)}</span>
      </div>
      {/* 文字の配置は見本（2026-09-26 ユーザー指示）どおり。カテゴリ・大きなタイトル・短い線・説明・日付／時間／場所／参加の一覧 */}
      <div className={`${styles.lHeroBody} ${fade}`}>
        {event.category ? <span className={styles.lPill}>{event.category.name}</span> : null}
        {/* 絵文字はタイトルの最後の文字に続けて置く（2 行に折れても離れないよう、間は改行しない文字でつなぐ） */}
        <h1 className={styles.lTitle} data-size={titleSize} data-emoji={event.emoji ? "true" : undefined} data-testid="main-title">
          <span className={styles.lTitleText}>
            {event.title}
            {event.emoji ? (
              <>
                {"\u2060"}
                <Emoji className={styles.lTitleEmoji}>{event.emoji}</Emoji>
              </>
            ) : null}
          </span>
        </h1>
        <span className={styles.lTitleRule} aria-hidden />
        {event.description ? <p className={styles.lDesc}>{event.description}</p> : null}
        <EventInfo event={event} />
      </div>
    </Fragment>
  );
}

/** 日付・時間・場所・参加（見本どおり 1 行ずつ。アイコンは本文の左端より外に出す）。主催があれば最後に足す */
function EventInfo({ event }: { event: SignageEvent }) {
  return (
    <ul className={styles.lInfo}>
      <li>
        <CalendarDays size={36} strokeWidth={1.7} aria-hidden />
        <span>{formatDateJa(event.startAt)}</span>
      </li>
      <li>
        <Clock size={36} strokeWidth={1.7} aria-hidden />
        <span>{formatTimeRange(event)}</span>
      </li>
      {event.location ? (
        <li>
          <PinIcon size={42} />
          <span>{event.location}</span>
        </li>
      ) : null}
      <li>
        <GroupIcon size={42} />
        <span>{formatParticipation(event)}</span>
      </li>
      {event.hostName ? (
        <li>
          <PersonIcon size={38} />
          <span>
            {COPY.hostPrefix}
            {event.hostName}
          </span>
        </li>
      ) : null}
    </ul>
  );
}

/** 1 行（見本どおり 左から 日付・写真・イベント名と時間／場所・説明の書き出し） */
function UpcomingRow({ event, resolveMediaUrl }: { event: SignageEvent; resolveMediaUrl: ResolveMediaUrl }) {
  return (
    <div className={styles.lRow} data-has-desc={event.description ? "true" : "false"}>
      <div className={styles.lRowDate}>
        <span className={styles.lRowDay}>{formatMonthDay(event.startAt)}</span>
        <span className={styles.lRowWeek}>{formatWeekdayUpper(event.startAt)}</span>
      </div>
      <div className={styles.lRowDivider} />
      <MediaImage
        media={event.image}
        category={event.category}
        resolveMediaUrl={resolveMediaUrl}
        className={styles.lRowImage}
      />
      <div className={styles.lRowText}>
        <span className={styles.lRowTitle}>{event.title}</span>
        <span className={styles.lRowMeta}>
          {formatTimeRange(event)}
          {event.location ? <span className={styles.lRowPlace}>{event.location}</span> : null}
        </span>
      </div>
      {event.description ? (
        <div className={styles.lRowDesc}>
          <span>{event.description}</span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * メンバー紹介（2026-09-26 ユーザー指示の見本どおり）。左に写真、右に会社名・ロゴ・お名前「さん」・肩書き・「ひとこと」・紹介文・タグ。
 * 1 人ずつ時刻で切り替える（spotlightIndex）。左右の矢印と下の点は、ほかにも紹介があることの目印（押す操作は無い）
 */
function Spotlight({ spotlight, resolveMediaUrl }: { spotlight: SignageView["spotlight"]; resolveMediaUrl: ResolveMediaUrl }) {
  if (!spotlight) {
    return (
      <div className={styles.lSpot} data-testid="spotlight">
        <div className={styles.lSpotEmpty}>{COPY.noSpotlight}</div>
      </div>
    );
  }
  const { item, index, count } = spotlight;
  const fade = count > 1 ? styles.heroFade : "";
  return (
    <>
      <div className={styles.lSpot} data-testid="spotlight">
        <div key={item.id} className={`${styles.lSpotBody} ${fade}`}>
          <MediaImage media={item.photo} category={null} resolveMediaUrl={resolveMediaUrl} className={styles.lSpotPhoto} />
          <div className={styles.lSpotText}>
            <div className={styles.lSpotCompany}>{item.companyName}</div>
            <div className={styles.lSpotName}>
              {item.personName}
              <span className={styles.lSpotSan}>{COPY.spotlightHonorific}</span>
            </div>
            {item.role ? <div className={styles.lSpotRole}>{item.role}</div> : null}
            {item.quote ? <p className={styles.lSpotQuote}>「{item.quote}」</p> : null}
            {item.bio ? <p className={styles.lSpotBio}>{item.bio}</p> : null}
            {item.tags.length > 0 ? (
              <div className={styles.lSpotTags}>
                {item.tags.map((tag, i) => (
                  <span key={i}>{tag}</span>
                ))}
              </div>
            ) : null}
          </div>
          {item.logo ? (
            // eslint-disable-next-line @next/next/no-img-element -- オフライン配信のため素の img
            <img src={resolveMediaUrl(item.logo)} alt="" className={styles.lSpotLogo} />
          ) : null}
        </div>
        {count > 1 ? (
          <>
            <ChevronLeft className={styles.lSpotPrev} size={28} strokeWidth={2} aria-hidden />
            <ChevronRight className={styles.lSpotNext} size={28} strokeWidth={2} aria-hidden />
          </>
        ) : null}
      </div>
      {count > 1 ? (
        <div className={styles.lSpotDots} data-testid="spotlight-dots" aria-hidden>
          {Array.from({ length: count }, (_, i) => (
            <span key={i} data-active={i === index ? "true" : undefined} />
          ))}
        </div>
      ) : null}
    </>
  );
}
