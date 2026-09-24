"use client";

/**
 * イベント管理（/admin/events）。リスト表示と月のカレンダー表示を切り替える。
 * すべて / 開催前 / 開催中 / 終了 の絞り込みと検索は両方の表示に効く。
 * 行の見た目はダッシュボードのイベント一覧（admin.module.css の .row）と同じ。
 */
import { CalendarDays, CheckCircle2, Clock, Ellipsis, List, Search, X } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { deleteEventAction } from "@/app/admin/_actions/events";
import admin from "./admin.module.css";
import { EventDeleteDialog } from "./event-delete-dialog";
import { EventMonthCalendar } from "./event-month-calendar";
import { SAVED_MESSAGES, type EventPhase, type ManagedEvent, type SavedNotice } from "./event-types";
import styles from "./events.module.css";
import { formatMonthDay, formatParticipants, formatTimeRange } from "./format";
import { PinFillIcon, UsersFillIcon } from "./icons";
import { useDismiss } from "./use-dismiss";

type Filter = "all" | EventPhase;
type View = "list" | "calendar";

const FILTERS: { value: Filter; label: string }[] = [
  { value: "all", label: "すべて" },
  { value: "before", label: "開催前" },
  { value: "ongoing", label: "開催中" },
  { value: "ended", label: "終了" },
];

/** 終わっていないものを開始順、終わったものは新しい順に後ろへ */
function sortForList(events: ManagedEvent[]): ManagedEvent[] {
  const live = events.filter((e) => e.phase !== "ended");
  const ended = events.filter((e) => e.phase === "ended").reverse();
  return [...live, ...ended];
}

function matches(e: ManagedEvent, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [e.title, e.location, e.category?.name, e.hostName, e.description]
    .filter((v): v is string => typeof v === "string")
    .some((v) => v.toLowerCase().includes(needle));
}

export function EventsManager({
  events,
  now,
  saved,
}: {
  /** 開始が早い順 */
  events: ManagedEvent[];
  now: number;
  saved: SavedNotice | null;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const [view, setView] = useState<View>("list");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [notice, setNotice] = useState<string | null>(saved ? SAVED_MESSAGES[saved] : null);
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<ManagedEvent | null>(null);
  const [pending, setPending] = useState(false);

  // 再読み込みで同じ知らせが出ないよう、URL から ?saved= を外す
  useEffect(() => {
    if (saved) router.replace(pathname, { scroll: false });
  }, [saved, router, pathname]);

  const visible = events.filter((e) => (filter === "all" || e.phase === filter) && matches(e, query));
  const rows = sortForList(visible);

  const remove = async () => {
    if (!deleting) return;
    setPending(true);
    try {
      const result = await deleteEventAction(deleting.id);
      if (result.ok) {
        setError(null);
        setNotice(SAVED_MESSAGES.deleted);
        router.refresh();
      } else {
        setError(result.error.message);
      }
    } catch {
      setError("削除できませんでした。通信の状態を確認して、もう一度お試しください");
    }
    setPending(false);
    setDeleting(null);
  };

  return (
    <div className={styles.page}>
      {notice ? (
        <div className={styles.toast} role="status">
          <CheckCircle2 size={18} strokeWidth={2.2} aria-hidden />
          <span>{notice}</span>
          <button type="button" className={styles.toastClose} aria-label="閉じる" onClick={() => setNotice(null)}>
            <X size={16} strokeWidth={2.4} aria-hidden />
          </button>
        </div>
      ) : null}

      <section className={`${admin.card} ${styles.listCard}`} aria-label="イベント管理">
        <div className={styles.listHead}>
          <h2 className={admin.listTitle}>イベント管理</h2>
          <span className={styles.count}>{events.length} 件</span>
          <div className={styles.viewSwitch} role="group" aria-label="表示の切り替え">
            <button type="button" aria-pressed={view === "list"} onClick={() => setView("list")}>
              <List size={16} strokeWidth={2.2} aria-hidden />
              リスト
            </button>
            <button type="button" aria-pressed={view === "calendar"} onClick={() => setView("calendar")}>
              <CalendarDays size={16} strokeWidth={2.2} aria-hidden />
              カレンダー
            </button>
          </div>
        </div>

        <div className={styles.toolbar}>
          <div className={`${admin.chips} ${styles.chipsLeft}`} role="group" aria-label="状態で絞り込む">
            {FILTERS.map((f) => (
              <button
                key={f.value}
                type="button"
                className={admin.chip}
                aria-pressed={filter === f.value}
                onClick={() => setFilter(f.value)}
              >
                {f.label}
              </button>
            ))}
          </div>
          <label className={styles.search}>
            <Search size={17} strokeWidth={2.2} aria-hidden />
            <input
              type="search"
              placeholder="イベント名・場所で探す"
              aria-label="イベントを検索"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </label>
        </div>

        {error ? (
          <p className={styles.bannerError} role="alert">
            {error}
          </p>
        ) : null}

        {view === "calendar" ? (
          <EventMonthCalendar events={visible} now={now} />
        ) : events.length === 0 ? (
          <div className={`${admin.empty} ${styles.emptyBox}`}>
            <p>イベントはまだありません。</p>
            <Link href="/admin/events/new" className={admin.emptyLink}>
              新しいイベントを作成
            </Link>
          </div>
        ) : rows.length === 0 ? (
          <div className={`${admin.empty} ${styles.emptyBox}`}>
            <p>条件に合うイベントはありません。</p>
          </div>
        ) : (
          <ul className={styles.rows}>
            {rows.map((e) => (
              <EventRow key={e.id} event={e} onDelete={() => setDeleting(e)} />
            ))}
          </ul>
        )}
      </section>

      {deleting ? (
        <EventDeleteDialog
          title={deleting.title}
          pending={pending}
          onConfirm={remove}
          onCancel={() => setDeleting(null)}
        />
      ) : null}
    </div>
  );
}

function EventRow({ event: e, onDelete }: { event: ManagedEvent; onDelete: () => void }) {
  const participants = formatParticipants(e.participantCount, e.capacity);
  return (
    <li className={`${admin.row} ${e.phase === "ended" ? styles.rowEnded : ""}`}>
      {e.imageUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img className={admin.rowThumb} src={e.imageUrl} alt="" />
      ) : (
        <div
          className={`${admin.rowThumb} ${admin.rowThumbEmpty}`}
          style={{ background: e.category?.color ?? "#c3ccd8" }}
          aria-hidden
        >
          {e.emoji ? <span className={admin.emoji}>{e.emoji}</span> : null}
        </div>
      )}
      <div className={admin.rowMain}>
        <span className={styles.tags}>
          {e.phase === "ongoing" ? <span className={`${admin.tag} ${admin.tagLive}`}>開催中</span> : null}
          {e.phase === "ended" ? <span className={`${admin.tag} ${styles.tagEnded}`}>終了</span> : null}
          {e.category ? (
            <span className={admin.tag} style={{ background: e.category.color }}>
              {e.category.name}
            </span>
          ) : null}
          {e.status === "draft" ? <span className={`${admin.tag} ${admin.tagDraft}`}>下書き</span> : null}
        </span>
        <p className={admin.rowTitle}>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{e.title}</span>
          {e.emoji ? (
            <span className={admin.emoji} aria-hidden>
              {e.emoji}
            </span>
          ) : null}
        </p>
        <p className={admin.rowDate}>
          <Clock className={admin.rowDateIcon} strokeWidth={2.2} aria-hidden />
          {formatMonthDay(e.startAt)} {formatTimeRange(e.startAt, e.endAt)}
        </p>
      </div>
      <p className={admin.rowLoc}>
        {e.location ? (
          <>
            <PinFillIcon className={admin.metaIcon} />
            {e.location}
          </>
        ) : null}
      </p>
      <p className={admin.rowCount}>
        {participants ? (
          <>
            <UsersFillIcon className={admin.metaIcon} />
            {participants}
          </>
        ) : null}
      </p>
      <Link href={`/admin/events/${e.id}`} className={`${admin.outlineButton} ${admin.rowEdit}`}>
        編集
      </Link>
      <RowMenu event={e} onDelete={onDelete} />
    </li>
  );
}

function RowMenu({ event, onDelete }: { event: ManagedEvent; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);

  return (
    <div ref={ref} className={admin.rowMore}>
      <button
        type="button"
        className={admin.outlineButton}
        aria-label={`${event.title} のその他の操作`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Ellipsis size={18} strokeWidth={2.6} aria-hidden />
      </button>
      {open ? (
        <div className={admin.popover} role="menu" style={{ minWidth: 140 }}>
          <Link href={`/admin/events/${event.id}`} className={admin.popoverItem} role="menuitem">
            編集
          </Link>
          <button
            type="button"
            className={`${admin.popoverItem} ${admin.dangerItem}`}
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onDelete();
            }}
          >
            削除
          </button>
        </div>
      ) : null}
    </div>
  );
}
