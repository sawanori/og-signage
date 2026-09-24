"use client";

/**
 * イベント一覧。すべて / 開催前 / 開催中 / 終了 の絞り込みと検索。編集とその他（削除）メニュー。
 * 「すべて」は終わっていないものを開始順に並べ、終わったものは新しい順に後ろへ回す。
 */
import { Clock, Ellipsis, Search } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useRef, useState, useTransition } from "react";
import { deleteEventAction } from "@/app/admin/_actions/events";
import { compareEventOrder, getEventState } from "@/lib/display-rules";
import styles from "./admin.module.css";
import { PinFillIcon, UsersFillIcon } from "./icons";
import type { DashboardEvent } from "./dashboard-types";
import { formatMonthDay, formatParticipants, formatTimeRange } from "./format";
import { useDismiss } from "./use-dismiss";

type Phase = "before" | "ongoing" | "ended";
type Filter = "all" | Phase;

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "すべて" },
  { value: "before", label: "開催前" },
  { value: "ongoing", label: "開催中" },
  { value: "ended", label: "終了" },
];

function phaseOf(e: DashboardEvent, now: number): Phase {
  const state = getEventState(e, now);
  if (state === "ended") return "ended";
  if (state === "now_happening") return "ongoing";
  return "before";
}

function sortForList(events: DashboardEvent[], now: number): DashboardEvent[] {
  const live = events.filter((e) => phaseOf(e, now) !== "ended").sort(compareEventOrder);
  const ended = events.filter((e) => phaseOf(e, now) === "ended").sort((a, b) => compareEventOrder(b, a));
  return [...live, ...ended];
}

function matches(e: DashboardEvent, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [e.title, e.location, e.category?.name, e.hostName, e.description]
    .filter((v): v is string => typeof v === "string")
    .some((v) => v.toLowerCase().includes(needle));
}

export function EventListCard({ events, now }: { events: DashboardEvent[]; now: number }) {
  const [filter, setFilter] = useState<Filter>("all");
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  const rows = sortForList(events, now).filter(
    (e) => (filter === "all" || phaseOf(e, now) === filter) && matches(e, query),
  );

  return (
    <section className={`${styles.card} ${styles.listCard}`} aria-label="イベント一覧">
      <div className={styles.listHead}>
        <h2 className={styles.listTitle}>イベント一覧</h2>
        {searchOpen ? (
          <input
            className={styles.searchInput}
            type="search"
            placeholder="イベント名・場所で探す"
            aria-label="イベントを検索"
            value={query}
            autoFocus
            onChange={(e) => setQuery(e.target.value)}
          />
        ) : (
          <div className={styles.chips} role="group" aria-label="状態で絞り込む">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                className={styles.chip}
                aria-pressed={filter === f.value}
                onClick={() => setFilter(f.value)}
              >
                {f.label}
              </button>
            ))}
          </div>
        )}
        <button
          type="button"
          className={styles.searchButton}
          aria-label={searchOpen ? "検索を閉じる" : "検索"}
          aria-expanded={searchOpen}
          onClick={() => {
            setSearchOpen((v) => !v);
            setQuery("");
          }}
        >
          <Search size={21} strokeWidth={2} aria-hidden />
        </button>
      </div>

      {events.length === 0 ? (
        <div className={styles.empty}>
          <p>イベントはまだありません。</p>
          <Link href="/admin/events/new" className={styles.emptyLink}>
            新しいイベントを作成
          </Link>
        </div>
      ) : rows.length === 0 ? (
        <div className={styles.empty}>
          <p>条件に合うイベントはありません。</p>
        </div>
      ) : (
        <ul className={styles.rows}>
          {rows.map((e) => (
            <EventRow key={e.id} event={e} now={now} onError={setError} />
          ))}
        </ul>
      )}
      {error ? (
        <p className={styles.cardError} role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function EventRow({ event: e, now, onError }: { event: DashboardEvent; now: number; onError: (m: string | null) => void }) {
  const live = phaseOf(e, now) === "ongoing";
  const participants = formatParticipants(e.participantCount, e.capacity);
  return (
    <li className={styles.row}>
      {e.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className={styles.rowThumb} src={e.imageUrl} alt="" />
      ) : (
        <div
          className={`${styles.rowThumb} ${styles.rowThumbEmpty}`}
          style={{ background: e.category?.color ?? "#c3ccd8" }}
          aria-hidden
        >
          {e.emoji ? <span className={styles.emoji}>{e.emoji}</span> : null}
        </div>
      )}
      <div className={styles.rowMain}>
        {e.status === "draft" ? (
          <span className={`${styles.tag} ${styles.tagDraft}`}>下書き</span>
        ) : live ? (
          <span className={`${styles.tag} ${styles.tagLive}`}>開催中</span>
        ) : e.category ? (
          <span className={styles.tag} style={{ background: e.category.color }}>
            {e.category.name}
          </span>
        ) : null}
        <p className={styles.rowTitle}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{e.title}</span>
          {e.emoji ? (
            <span className={styles.emoji} aria-hidden>
              {e.emoji}
            </span>
          ) : null}
        </p>
        <p className={styles.rowDate}>
          <Clock className={styles.rowDateIcon} strokeWidth={2.2} aria-hidden />
          {formatMonthDay(e.startAt)} {formatTimeRange(e.startAt, e.endAt)}
        </p>
      </div>
      <p className={styles.rowLoc}>
        {e.location ? (
          <>
            <PinFillIcon className={styles.metaIcon} />
            {e.location}
          </>
        ) : null}
      </p>
      <p className={styles.rowCount}>
        {participants ? (
          <>
            <UsersFillIcon className={styles.metaIcon} />
            {participants}
          </>
        ) : null}
      </p>
      <Link href={`/admin/events/${e.id}`} className={`${styles.outlineButton} ${styles.rowEdit}`}>
        編集
      </Link>
      <RowMenu event={e} onError={onError} />
    </li>
  );
}

function RowMenu({ event, onError }: { event: DashboardEvent; onError: (m: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const ref = useRef<HTMLDivElement>(null);
  const router = useRouter();
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);

  const remove = () => {
    setOpen(false);
    if (!window.confirm(`「${event.title}」を削除します。よろしいですか？`)) return;
    startTransition(async () => {
      const result = await deleteEventAction(event.id);
      if (result.ok) {
        onError(null);
        router.refresh();
      } else {
        onError(result.error.message);
      }
    });
  };

  return (
    <div ref={ref} className={styles.rowMore}>
      <button
        type="button"
        className={styles.outlineButton}
        aria-label={`${event.title} のその他の操作`}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={pending}
        onClick={() => setOpen((v) => !v)}
      >
        <Ellipsis size={18} strokeWidth={2.6} aria-hidden />
      </button>
      {open ? (
        <div className={styles.popover} role="menu" style={{ minWidth: 140 }}>
          <Link href={`/admin/events/${event.id}`} className={styles.popoverItem} role="menuitem">
            編集
          </Link>
          <button type="button" className={`${styles.popoverItem} ${styles.dangerItem}`} role="menuitem" onClick={remove}>
            削除
          </button>
        </div>
      ) : null}
    </div>
  );
}
