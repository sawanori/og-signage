/**
 * 横型（1920×1080）の配置。モック image/UI-H.png の画面部分に合わせる。
 * 2026-09-25 ユーザー指示: ヘッダーを 2/3 の高さ（92px）に。下段の欄のうち今週の予定は外し、大きな枠をフッターまで広げる。
 * 右の列は上から メンバー情報・UPCOMING（6 件）・お知らせ（HOUSE NEWS。白いカードで縁はドロップシャドウ）。
 * どれも同じ左端（1368px）・幅（516px）。キャッチコピー（ヘッダー用）は横型では出さない。
 */
import { Fragment } from "react";
import { ArrowRight, Clock } from "lucide-react";
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
  tint,
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
      {/* メンバー情報。右の列の一番上で、UPCOMING と同じ左端・幅・見出しの並び（2026-09-25 ユーザー指示） */}
      <div className={styles.lSectionTitle} style={{ left: stretchX(1372, 1), top: 14 }}>
        <span className={styles.lSectionEn}>{COPY.rules.en}</span>
        <span className={styles.lSectionJa}>{COPY.rules.ja}</span>
      </div>
      <div className={styles.lRules} data-testid="rules">
        {house.rules.map((rule, i) => (
          <div key={i} className={styles.lRule}>
            {rule.title ? <span className={styles.lRuleTitle}>{rule.title}</span> : null}
            <span className={styles.lRuleText}>{rule.text}</span>
          </div>
        ))}
      </div>

      {/* 今日のイベント */}
      <Hero hero={view.hero} config={config} resolveMediaUrl={resolveMediaUrl} />

      {/* Upcoming */}
      <div className={styles.lSectionTitle} style={{ left: stretchX(1372, 1), top: 146 }}>
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
        {/* お知らせ。右の列の一番下（2026-09-25 ユーザー指示。大きめの白いカードで、縁はドロップシャドウ） */}
        <div className={styles.lNews} data-testid="notice">
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
          {/* eslint-disable-next-line @next/next/no-img-element -- オフライン配信のため素の img */}
          <img src={WEWORK_LOGO_SRC} alt="WeWork" className={styles.lFooterLogo} />
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
  const longTitle = [...event.title].length > 12;
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
      <div className={`${styles.lCircle} ${fade}`} data-state={state} data-testid="state-badge">
        <span className={styles.lCircleEn} data-long={label.en.length > 5 ? "true" : "false"}>
          {label.en}
        </span>
        <span className={styles.lCircleDate}>{formatMonthDay(event.startAt)}</span>
        <span className={styles.lCircleWeek}>{formatWeekdayUpper(event.startAt)}</span>
      </div>
      <div className={`${styles.lHeroBody} ${fade}`}>
        {event.category ? <span className={styles.lPill}>{event.category.name}</span> : null}
        <h1 className={styles.lTitle} data-long={longTitle ? "true" : "false"} data-testid="main-title">
          <span className={styles.lTitleText}>{event.title}</span>
          {event.emoji ? <Emoji className={styles.lTitleEmoji}>{event.emoji}</Emoji> : null}
        </h1>
        {event.description ? <p className={styles.lDesc}>{event.description}</p> : null}
        <EventInfo event={event} withDate={state === "upcoming"} />
      </div>
    </Fragment>
  );
}

/** 明日以降のイベントは、時間の前に日付を付ける（どの日のイベントか分かるように） */
function EventInfo({ event, withDate }: { event: SignageEvent; withDate: boolean }) {
  return (
    <ul className={styles.lInfo}>
      <li className={styles.lInfoStrong}>
        <Clock size={32} strokeWidth={1.8} aria-hidden />
        <span>{withDate ? `${formatDateJa(event.startAt)} ${formatTimeRange(event)}` : formatTimeRange(event)}</span>
      </li>
      {event.location ? (
        <li className={styles.lInfoStrong}>
          <PinIcon size={34} />
          <span>{event.location}</span>
        </li>
      ) : null}
      <li>
        <GroupIcon size={34} />
        <span>{formatParticipation(event)}</span>
      </li>
      {event.hostName ? (
        <li>
          <PersonIcon size={34} />
          <span>
            {COPY.hostPrefix}
            {event.hostName}
          </span>
        </li>
      ) : null}
    </ul>
  );
}

function UpcomingRow({ event, resolveMediaUrl }: { event: SignageEvent; resolveMediaUrl: ResolveMediaUrl }) {
  return (
    <div className={styles.lRow}>
      <div className={styles.lRowDate}>
        <span className={styles.lRowDay}>{formatMonthDay(event.startAt)}</span>
        <span className={styles.lRowWeek}>{formatWeekdayUpper(event.startAt)}</span>
      </div>
      <div className={styles.lRowDivider} />
      <div className={styles.lRowText}>
        {event.category ? (
          <span className={styles.lChip} style={{ backgroundColor: tint(event.category.color, 0.35) }}>
            {event.category.name}
          </span>
        ) : null}
        <span className={styles.lRowTitle}>{event.title}</span>
        <span className={styles.lRowMeta}>
          {formatTimeRange(event)}
          {event.location ? <span className={styles.lRowPlace}>{event.location}</span> : null}
        </span>
      </div>
      <MediaImage
        media={event.image}
        category={event.category}
        resolveMediaUrl={resolveMediaUrl}
        className={styles.lRowImage}
      />
    </div>
  );
}
