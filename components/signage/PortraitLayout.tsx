/**
 * 縦型（1080×1920）の配置。モック image/UI-V.png の画面部分に合わせる。
 */
import { ArrowRight, ChevronRight, Clock, House } from "lucide-react";
import type { SignageConfig, SignageEvent } from "@/lib/config-schema";
import type { MainEventSelection } from "@/lib/display-rules";
import { COPY } from "./copy";
import {
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
  isQrUrl,
  MediaImage,
  PersonOutlineIcon,
  PinIcon,
  QrCode,
  RuleIcon,
  WeatherIcon,
} from "./parts";
import styles from "./signage.module.css";

type Props = { config: SignageConfig; view: SignageView; resolveMediaUrl: ResolveMediaUrl };

export function PortraitLayout({ config, view, resolveMediaUrl }: Props) {
  const { house } = config;
  const footer = splitFooterCopy(house.footerCopy);
  return (
    <div className={styles.portrait}>
      {/* ヘッダー */}
      <div className={styles.pLogo}>
        {house.logo ? (
          // eslint-disable-next-line @next/next/no-img-element -- オフライン配信のため素の img
          <img src={resolveMediaUrl(house.logo)} alt="" className={styles.contain} />
        ) : (
          <House size={78} strokeWidth={1.6} aria-hidden />
        )}
      </div>
      <div className={styles.pHouseName}>{house.name}</div>
      <div className={styles.pHouseKind}>{COPY.portraitHouseKind}</div>
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
        </div>
      ) : null}

      {/* 今日のイベント */}
      <Hero main={view.main} config={config} resolveMediaUrl={resolveMediaUrl} />

      {/* Upcoming */}
      <div className={styles.pSectionTitle} style={{ left: 42, top: 961 }}>
        <span className={styles.pSectionEn}>{COPY.upcoming.en}</span>
        <span className={styles.pSectionJa}>{COPY.upcoming.ja}</span>
      </div>
      <div className={styles.pSeeAll}>
        {COPY.seeAll} <ArrowRight size={22} strokeWidth={1.6} aria-hidden />
      </div>
      <div className={styles.pUpcoming} data-testid="upcoming">
        {view.upcoming.length === 0 ? <div className={styles.pEmpty}>{COPY.noUpcoming}</div> : null}
        {view.upcoming.map((event) => (
          <UpcomingRow key={event.id} event={event} resolveMediaUrl={resolveMediaUrl} />
        ))}
      </div>

      {/* お知らせ */}
      <div className={`${styles.pSectionTitle} ${styles.pSectionSmall}`} style={{ left: 40, top: 1576 }}>
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

      {/* ハウスルール */}
      <div className={`${styles.pSectionTitle} ${styles.pSectionSmall}`} style={{ left: 568, top: 1571 }}>
        <span className={styles.pSectionEn}>{COPY.rules.en}</span>
        <span className={styles.pSectionJa}>{COPY.rules.ja}</span>
      </div>
      <div className={styles.pRules} data-testid="rules">
        {house.rules.map((rule, i) => (
          <div key={i} className={styles.pRule}>
            <span className={styles.pRuleIcon}>
              <RuleIcon icon={rule.icon} size={46} strokeWidth={1.8} />
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
  main,
  config,
  resolveMediaUrl,
}: {
  main: MainEventSelection;
  config: SignageConfig;
  resolveMediaUrl: ResolveMediaUrl;
}) {
  if (main.kind !== "today") {
    return <HeroWithoutToday main={main} config={config} resolveMediaUrl={resolveMediaUrl} />;
  }
  const { event, state } = main;
  const label = stateLabel(state);
  const catchLines = splitCatchCopy(event.catchCopy);
  const longTitle = [...event.title].length > 12;
  return (
    <MediaImage
      media={event.image}
      category={event.category}
      resolveMediaUrl={resolveMediaUrl}
      className={styles.pHero}
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
        <EventInfo event={event} />
        <div className={styles.pButton} aria-hidden>
          {COPY.detailPortrait}
          <ArrowRight size={26} strokeWidth={1.7} />
        </div>
      </div>
      {isQrUrl(event.qrUrl) ? (
        <div className={styles.pQr}>
          <QrCode url={event.qrUrl} size={130} />
          <span className={styles.pQrLabel}>{COPY.qrLabel}</span>
        </div>
      ) : null}
    </MediaImage>
  );
}

function EventInfo({ event }: { event: SignageEvent }) {
  return (
    <ul className={styles.pInfo}>
      <li>
        <Clock size={31} strokeWidth={2} aria-hidden />
        <span>{formatTimeRange(event)}</span>
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

/** 今日のイベントがないとき。次のイベントを小さく、それもなければハウスのキャッチコピー */
function HeroWithoutToday({
  main,
  config,
  resolveMediaUrl,
}: {
  main: Exclude<MainEventSelection, { kind: "today" }>;
  config: SignageConfig;
  resolveMediaUrl: ResolveMediaUrl;
}) {
  const copy = config.house.headerCopy ?? config.house.name;
  return (
    <div className={`${styles.pHero} ${styles.pHeroQuiet}`} data-testid="no-event">
      <div className={styles.quietCopy}>{copy}</div>
      <div className={styles.quietNote}>{COPY.noEventsToday}</div>
      {main.kind === "next" ? (
        <div className={styles.pNext} data-testid="next-event">
          <span className={styles.pNextLabel}>
            {COPY.nextEvent.en}
            <small>{COPY.nextEvent.ja}</small>
          </span>
          <MediaImage
            media={main.event.image}
            category={main.event.category}
            resolveMediaUrl={resolveMediaUrl}
            className={styles.pNextImage}
          />
          <span className={styles.pNextDate}>
            {formatMonthDay(main.event.startAt)}
            <small>{formatWeekdayUpper(main.event.startAt)}</small>
          </span>
          <span className={styles.pNextText}>
            <span className={styles.pNextTitle}>{main.event.title}</span>
            <span className={styles.pNextMeta}>
              {formatTimeRange(main.event)}
              {main.event.location ? `　${main.event.location}` : ""}
            </span>
          </span>
        </div>
      ) : null}
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
      <ChevronRight className={styles.pRowChevron} size={26} strokeWidth={1.8} aria-hidden />
    </div>
  );
}
