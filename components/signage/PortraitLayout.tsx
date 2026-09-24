/**
 * 縦型（1080×1920）の配置。モック image/UI-V.png の画面部分に合わせる。
 */
import { Clock } from "lucide-react";
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
import {
  Emoji,
  GroupIcon,
  HeroDots,
  isQrUrl,
  MediaImage,
  PersonOutlineIcon,
  PinIcon,
  QrCode,
  RuleIcon,
  WeatherIcon,
} from "./parts";
import styles from "./signage.module.css";
import { WEWORK_LOGO_DARK_SRC } from "./wework-logo";

type Props = { config: SignageConfig; view: SignageView; resolveMediaUrl: ResolveMediaUrl };

/** 縦型の Upcoming は 3 行（大きな枠を広げるため。全イベントの詳細は大きな枠のスライドショーで流す） */
const PORTRAIT_UPCOMING_ROWS = 3;

/** 長いハウス名（17 文字以上。例: OCEAN GATE MINATOMIRAI）は、右の日付・時計にかからないよう小さく出す */
const isLongHouseName = (name: string) => [...name].length > 16;

export function PortraitLayout({ config, view, resolveMediaUrl }: Props) {
  const { house } = config;
  const footer = splitFooterCopy(house.footerCopy);
  return (
    <div className={styles.portrait}>
      {/* ヘッダー。ロゴ｜細い縦線｜ハウス名と添え書き。ロゴ未設定なら WeWork のロゴ */}
      <div className={styles.pBrand}>
        {house.logo ? (
          // eslint-disable-next-line @next/next/no-img-element -- オフライン配信のため素の img
          <img src={resolveMediaUrl(house.logo)} alt="" className={styles.pLogo} />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element -- オフライン配信のため素の img
          <img src={WEWORK_LOGO_DARK_SRC} alt="WeWork" className={styles.pWordmark} />
        )}
        <span className={styles.pBrandRule} aria-hidden />
        <div>
          <div className={styles.pHouseName} data-long={isLongHouseName(house.name) ? "true" : "false"}>
            {house.name}
          </div>
          <div className={styles.pHouseKind}>{COPY.portraitHouseKind}</div>
        </div>
      </div>
      {house.headerCopy ? <div className={styles.pHeaderCopy}>{house.headerCopy}</div> : null}
      <div className={styles.pTagline}>{COPY.portraitTagline}</div>

      <div className={styles.pDate}>
        {view.clock.year}.{view.clock.month}.{view.clock.day} {view.clock.weekdayShort}
      </div>
      <div className={styles.pTime}>{view.clock.time}</div>
      {view.weather ? (
        <div className={styles.pWeather} data-testid="weather">
          <span className={styles.pWeatherIcon}>
            <WeatherIcon condition={view.weather.condition} size={66} strokeWidth={1.7} />
          </span>
          <span className={styles.pTemp}>{Math.round(view.weather.temperatureC)}
            <span className={styles.deg}>°</span>C
          </span>
          <span className={styles.pPlace}>{view.weather.locationName}</span>
          <span className={styles.pWeatherAttribution} data-testid="weather-attribution">
            {COPY.weatherAttribution}
          </span>
        </div>
      ) : null}

      {/* 今日のイベント */}
      <Hero hero={view.hero} config={config} resolveMediaUrl={resolveMediaUrl} />

      {/* Upcoming */}
      <div className={styles.pSectionTitle} style={{ left: 42, top: 1230 }}>
        <span className={styles.pSectionEn}>{COPY.upcoming.en}</span>
        <span className={styles.pSectionJa}>{COPY.upcoming.ja}</span>
      </div>
      <div className={styles.pUpcoming} data-testid="upcoming">
        {view.upcoming.length === 0 ? <div className={styles.pEmpty}>{COPY.noUpcoming}</div> : null}
        {view.upcoming.slice(0, PORTRAIT_UPCOMING_ROWS).map((event) => (
          <UpcomingRow key={event.id} event={event} resolveMediaUrl={resolveMediaUrl} />
        ))}
      </div>

      {/* お知らせ */}
      <div className={`${styles.pSectionTitle} ${styles.pSectionSmall}`} style={{ left: 40, top: 1628 }}>
        <span className={styles.pSectionEn}>{COPY.news.en}</span>
        <span className={styles.pSectionJa}>{COPY.news.ja}</span>
      </div>
      <div className={styles.pNews} data-testid="notice">
        {view.notice ? (
          <>
            {view.notice.image ? (
              <MediaImage
                media={view.notice.image}
                category={null}
                resolveMediaUrl={resolveMediaUrl}
                className={styles.pNewsImage}
              />
            ) : null}
            <div className={styles.pNewsText} data-has-image={view.notice.image ? "true" : "false"}>
              <div className={styles.pNewsTitle}>{view.notice.title}</div>
              {view.notice.body ? <div className={styles.pNewsBody}>{view.notice.body}</div> : null}
            </div>
          </>
        ) : (
          <div className={styles.pEmpty}>{COPY.noNotice}</div>
        )}
      </div>
      <div className={styles.pDivider} />

      {/* メンバー情報（config の house.rules） */}
      <div className={`${styles.pSectionTitle} ${styles.pSectionSmall}`} style={{ left: 568, top: 1623 }}>
        <span className={styles.pSectionEn}>{COPY.rules.en}</span>
        <span className={styles.pSectionJa}>{COPY.rules.ja}</span>
      </div>
      <div className={styles.pRules} data-testid="rules">
        {house.rules.map((rule, i) => (
          <div key={i} className={styles.pRule}>
            <span className={styles.pRuleIcon}>
              <RuleIcon icon={rule.icon} size={38} strokeWidth={1.8} />
            </span>
            <span className={styles.pRuleText}>{rule.text}</span>
          </div>
        ))}
      </div>

      {/* フッター */}
      <div className={styles.pFooter}>
        {house.footerImage ? (
          // eslint-disable-next-line @next/next/no-img-element -- オフライン配信のため素の img
          <img src={resolveMediaUrl(house.footerImage)} alt="" className={styles.cover} />
        ) : null}
        {footer.lead ? <div className={styles.pFooterLead}>“{footer.lead}”</div> : null}
        {footer.sub.length > 0 ? <div className={styles.pFooterSub}>{footer.sub.join("\n")}</div> : null}
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
  if (!hero) return <QuietHero config={config} />;
  const { slide, index, count } = hero;
  const { event, state } = slide;
  const label = stateLabel(state);
  const catchLines = splitCatchCopy(event.catchCopy);
  const longTitle = [...event.title].length > 12;
  return (
    <MediaImage
      key={event.id}
      media={event.image}
      category={event.category}
      resolveMediaUrl={resolveMediaUrl}
      className={count > 1 ? `${styles.pHero} ${styles.heroFade}` : styles.pHero}
    >
      <div className={styles.pHeroShade} />
      <div className={styles.pBadge} data-state={state} data-testid="state-badge">
        <span className={styles.pBadgeEn}>{label.en}</span>
        <span className={styles.pBadgeJa}>{label.ja}</span>
      </div>
      {catchLines.length > 0 ? (
        <div className={styles.pCatch} aria-hidden>
          <span className={styles.pCatchTick1} />
          {catchLines.slice(0, 2).map((line, i) => (
            <span key={i} className={styles.pCatchLine} style={{ marginLeft: i * 30 }}>
              {line}
            </span>
          ))}
          <span className={styles.pCatchTick2} />
        </div>
      ) : null}
      <div className={styles.pHeroBody}>
        <h1 className={styles.pTitle} data-long={longTitle ? "true" : "false"} data-testid="main-title">
          <span className={styles.pTitleText}>{event.title}</span>
          {event.emoji ? <Emoji className={styles.pTitleEmoji}>{event.emoji}</Emoji> : null}
        </h1>
        {event.description ? <p className={styles.pDesc}>{event.description}</p> : null}
        <EventInfo event={event} withDate={state === "upcoming"} />
      </div>
      <div className={`${styles.heroCorner} ${styles.pCorner}`}>
        {isQrUrl(event.qrUrl) ? (
          <div className={styles.pQr}>
            <QrCode url={event.qrUrl} size={130} />
            <span className={styles.pQrLabel}>{COPY.qrLabel}</span>
          </div>
        ) : null}
        {count > 1 ? <HeroDots index={index} count={count} /> : null}
      </div>
    </MediaImage>
  );
}

/** 明日以降のイベントは、時間の前に日付を付ける（どの日のイベントか分かるように） */
function EventInfo({ event, withDate }: { event: SignageEvent; withDate: boolean }) {
  return (
    <ul className={styles.pInfo}>
      <li>
        <Clock size={31} strokeWidth={2} aria-hidden />
        <span>{withDate ? `${formatDateJa(event.startAt)} ${formatTimeRange(event)}` : formatTimeRange(event)}</span>
      </li>
      {event.location ? (
        <li>
          <PinIcon size={32} />
          <span>{event.location}</span>
        </li>
      ) : null}
      <li>
        <GroupIcon size={34} />
        <span>{formatParticipation(event)}</span>
      </li>
      {event.hostName ? (
        <li>
          <PersonOutlineIcon size={34} />
          <span>
            {COPY.hostPrefix}
            {event.hostName}
          </span>
        </li>
      ) : null}
    </ul>
  );
}

/** 流すイベントが 1 件も無いとき。ハウスのキャッチコピーを出す */
function QuietHero({ config }: { config: SignageConfig }) {
  const copy = config.house.headerCopy ?? config.house.name;
  return (
    <div className={`${styles.pHero} ${styles.pHeroQuiet}`} data-testid="no-event">
      <div className={styles.quietCopy}>{copy}</div>
      <div className={styles.quietNote}>{COPY.noUpcoming}</div>
    </div>
  );
}

function UpcomingRow({ event, resolveMediaUrl }: { event: SignageEvent; resolveMediaUrl: ResolveMediaUrl }) {
  return (
    <div className={styles.pRow}>
      <div className={styles.pRowDate}>
        <span className={styles.pRowDay}>{formatMonthDay(event.startAt)}</span>
        <span className={styles.pRowWeek}>{formatWeekdayUpper(event.startAt)}</span>
      </div>
      <div className={styles.pRowDivider} />
      <div className={styles.pRowText}>
        {event.category ? (
          <span className={styles.pChip} style={{ backgroundColor: tint(event.category.color, 0.45) }}>
            {event.category.name}
          </span>
        ) : null}
        <span className={styles.pRowTitle}>{event.title}</span>
        <span className={styles.pRowMeta}>
          {formatTimeRange(event)}
          {event.location ? (
            <>
              <span className={styles.pRowSep}>|</span>
              {event.location}
            </>
          ) : null}
        </span>
      </div>
      <MediaImage
        media={event.image}
        category={event.category}
        resolveMediaUrl={resolveMediaUrl}
        className={styles.pRowImage}
      />
    </div>
  );
}
