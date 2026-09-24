/**
 * 横型（1920×1080）の配置。モック image/UI-H.png の画面部分に合わせる。
 */
import { ArrowRight, ChevronRight, Clock, House } from "lucide-react";
import type { SignageConfig, SignageEvent } from "@/lib/config-schema";
import type { MainEventSelection } from "@/lib/display-rules";
import { tokyoParts } from "@/lib/dates";
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
import { Emoji, GroupIcon, isQrUrl, MediaImage, PersonIcon, PinIcon, QrCode, RuleIcon, WeatherIcon } from "./parts";
import styles from "./signage.module.css";

type Props = { config: SignageConfig; view: SignageView; resolveMediaUrl: ResolveMediaUrl };

export function LandscapeLayout({ config, view, resolveMediaUrl }: Props) {
  const { house } = config;
  const footer = splitFooterCopy(house.footerCopy);
  return (
    <div className={styles.landscape}>
      {/* ヘッダー */}
      <div className={styles.lHeaderBand} />
      <div className={styles.lLogo}>
        {house.logo ? (
          // eslint-disable-next-line @next/next/no-img-element -- オフライン配信のため素の img
          <img src={resolveMediaUrl(house.logo)} alt="" className={styles.contain} />
        ) : (
          <House size={60} strokeWidth={1.6} aria-hidden />
        )}
      </div>
      <div className={styles.lHouseName}>{house.name}</div>
      <div className={styles.lHouseKind}>{COPY.landscapeHouseKind}</div>
      <div className={styles.lScript} aria-hidden>
        <span>{COPY.landscapeTaglineScript[0]}</span>
        <span style={{ marginLeft: 70 }}>{COPY.landscapeTaglineScript[1]}</span>
      </div>
      <svg className={styles.lScriptLine} width="160" height="24" viewBox="0 0 160 24" aria-hidden>
        <path d="M2 20 C 50 12, 100 8, 158 6" fill="none" stroke="#1B2530" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <div className={styles.lBox}>
        {house.headerCopy ? <div className={styles.lBoxCopy}>{house.headerCopy}</div> : null}
        <div className={styles.lBoxTagline}>{COPY.landscapeBoxTagline.join("\n")}</div>
      </div>

      {/* 今日のイベント */}
      <Hero main={view.main} config={config} resolveMediaUrl={resolveMediaUrl} />

      {/* Upcoming */}
      <div className={styles.lSectionTitle} style={{ left: 1272, top: 179 }}>
        <span className={styles.lSectionEn}>{COPY.upcoming.en}</span>
        <span className={styles.lSectionJa}>{COPY.upcoming.ja}</span>
      </div>
      <div className={styles.lUpcoming} data-testid="upcoming">
        {view.upcoming.length === 0 ? <div className={styles.pEmpty}>{COPY.noUpcoming}</div> : null}
        {view.upcoming.map((event) => (
          <UpcomingRow key={event.id} event={event} resolveMediaUrl={resolveMediaUrl} />
        ))}
      </div>

      {/* 下段 */}
      <div className={styles.lBottomBand} />
      <div className={styles.lSectionTitle} style={{ left: 50, top: 779 }}>
        <span className={styles.lSectionEn}>{COPY.news.en}</span>
        <span className={styles.lSectionJa}>{COPY.news.ja}</span>
      </div>
      <div className={styles.lNews} data-testid="notice">
        {view.notice ? (
          <>
            {view.notice.image ? (
              <MediaImage
                media={view.notice.image}
                category={null}
                resolveMediaUrl={resolveMediaUrl}
                className={styles.lNewsImage}
              />
            ) : null}
            <div className={styles.lNewsText} data-has-image={view.notice.image ? "true" : "false"}>
              <div className={styles.lNewsTitle}>{view.notice.title}</div>
              {view.notice.body ? <div className={styles.lNewsBody}>{view.notice.body}</div> : null}
            </div>
          </>
        ) : (
          <div className={styles.pEmpty}>{COPY.noNotice}</div>
        )}
      </div>
      <div className={styles.lDivider} style={{ left: 592 }} />

      <div className={styles.lSectionTitle} style={{ left: 618, top: 779 }}>
        <span className={styles.lSectionEn}>{COPY.week.en}</span>
        <span className={styles.lSectionJa}>{COPY.week.ja}</span>
      </div>
      <div className={styles.lWeek} data-testid="week">
        {view.week.map((day) => {
          const p = tokyoParts(day.startAt);
          const first = day.events[0];
          return (
            <div key={day.dateKey} className={styles.lWeekDay} data-today={day.isToday ? "true" : "false"}>
              <span className={styles.lWeekName}>{formatWeekdayUpper(day.startAt)}</span>
              <span className={styles.lWeekNum}>{p.day}</span>
              <span className={styles.lWeekMark}>
                {first ? (
                  first.emoji ? (
                    <Emoji>{first.emoji}</Emoji>
                  ) : (
                    <span className={styles.lWeekDot} style={{ backgroundColor: first.category?.color ?? "#1B2530" }} />
                  )
                ) : (
                  <span className={styles.lWeekDash} />
                )}
              </span>
            </div>
          );
        })}
      </div>
      <div className={styles.lDivider} style={{ left: 1290 }} />

      <div className={styles.lSectionTitle} style={{ left: 1317, top: 779 }}>
        <span className={styles.lSectionEn}>{COPY.rules.en}</span>
        <span className={styles.lSectionJa}>{COPY.rules.ja}</span>
      </div>
      <div className={styles.lRules} data-testid="rules">
        {house.rules.map((rule, i) => (
          <div key={i} className={styles.lRule}>
            <span className={styles.lRuleIcon}>
              <RuleIcon icon={rule.icon} size={40} strokeWidth={1.8} />
            </span>
            <span className={styles.lRuleText}>{rule.text}</span>
          </div>
        ))}
      </div>

      {/* フッター */}
      <div className={styles.lFooter}>
        <div className={styles.lFooterTime}>{view.clock.time}</div>
        <div className={styles.lFooterDate}>
          {view.clock.year}. {view.clock.month}.{view.clock.day} ({view.clock.weekdayShort})
        </div>
        {view.weather ? (
          <div className={styles.lFooterWeather} data-testid="weather">
            <WeatherIcon condition={view.weather.condition} size={42} strokeWidth={1.7} />
            <span className={styles.lFooterTemp}>{Math.round(view.weather.temperatureC)}
            <span className={styles.deg}>°</span>C
          </span>
            <span className={styles.lFooterPlace}>{view.weather.locationName}</span>
            <span className={styles.lWeatherAttribution} data-testid="weather-attribution">
              {COPY.weatherAttribution}
            </span>
          </div>
        ) : null}
        <div className={styles.lFooterDivider} />
        <div className={styles.lFooterCopy}>
          {footer.lead ? <div className={styles.lFooterLead}>“{footer.lead}”</div> : null}
          {footer.sub.length > 0 ? <div className={styles.lFooterSub}>{footer.sub.join("")}</div> : null}
        </div>
        <div className={styles.lFooterHouse}>
          <House size={40} strokeWidth={1.6} aria-hidden />
          <span>{house.name}</span>
        </div>
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
    const copy = config.house.headerCopy ?? config.house.name;
    return (
      <div className={`${styles.lHero} ${styles.lHeroQuiet}`} data-testid="no-event">
        <div className={styles.quietCopy}>{copy}</div>
        <div className={styles.quietNote}>{COPY.noEventsToday}</div>
        {main.kind === "next" ? (
          <div className={styles.lNext} data-testid="next-event">
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
  const { event, state } = main;
  const label = stateLabel(state);
  const catchLines = splitCatchCopy(event.catchCopy);
  const longTitle = [...event.title].length > 12;
  return (
    <>
      <MediaImage media={event.image} category={event.category} resolveMediaUrl={resolveMediaUrl} className={styles.lHero}>
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
      </MediaImage>
      <div className={styles.lCircle} data-state={state} data-testid="state-badge">
        <span className={styles.lCircleEn} data-long={label.en.length > 5 ? "true" : "false"}>
          {label.en}
        </span>
        <span className={styles.lCircleDate}>{formatMonthDay(event.startAt)}</span>
        <span className={styles.lCircleWeek}>{formatWeekdayUpper(event.startAt)}</span>
      </div>
      <div className={styles.lHeroBody}>
        {event.category ? <span className={styles.lPill}>{event.category.name}</span> : null}
        <h1 className={styles.lTitle} data-long={longTitle ? "true" : "false"} data-testid="main-title">
          <span className={styles.lTitleText}>{event.title}</span>
          {event.emoji ? <Emoji className={styles.lTitleEmoji}>{event.emoji}</Emoji> : null}
        </h1>
        {event.description ? <p className={styles.lDesc}>{event.description}</p> : null}
        <EventInfo event={event} />
        <div className={styles.lButton} aria-hidden>
          {COPY.detailLandscape}
          <ArrowRight size={24} strokeWidth={1.8} />
        </div>
      </div>
      {isQrUrl(event.qrUrl) ? (
        <div className={styles.lQr}>
          <QrCode url={event.qrUrl} size={106} />
          <span className={styles.lQrLabel}>{COPY.qrLabel}</span>
        </div>
      ) : null}
    </>
  );
}

function EventInfo({ event }: { event: SignageEvent }) {
  return (
    <ul className={styles.lInfo}>
      <li className={styles.lInfoStrong}>
        <Clock size={32} strokeWidth={1.8} aria-hidden />
        <span>{formatTimeRange(event)}</span>
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
      <ChevronRight className={styles.lRowChevron} size={24} strokeWidth={1.8} aria-hidden />
    </div>
  );
}
