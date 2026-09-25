"use client";

/**
 * 定期動画の設定（要件定義書 14 節）。ON/OFF・間隔・再生する動画（並べ替え・追加・外す）・再生順を
 * 画面上で変えてから「保存する」でまとめて保存する。
 *
 * 保存は saveDevicePlaybackAction の 1 回で、プレイリストの中身（mediaId の並び）と再生設定を
 * 1 トランザクションで丸ごと保存する。revision が合わなければ何も書かれず、入力は画面に残る。
 */
import { Check, CircleAlert, CircleHelp, GripVertical, Play, Plus, X } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition, type KeyboardEvent } from "react";
import { requestTestPlayAction, saveDevicePlaybackAction } from "@/app/admin/_actions/playback";
import { VIDEO_INTERVAL_MINUTES } from "@/lib/config-schema";
import { MAX_VIDEO_SECONDS, MAX_VIDEOS, isVideoTooLong } from "@/lib/file-sniff";
import admin from "./admin.module.css";
import { formatDuration } from "./format";
import {
  UNPLAYABLE_MESSAGE,
  type DeviceOption,
  type PlaylistEntry,
  type VideoLibraryItem,
  type VideosPageData,
  type VideoSettingsValues,
} from "./media-types";
import styles from "./media.module.css";

const HELP =
  "イベント表示の合間に、設定した間隔で動画を 1 本ずつ全画面で再生します。間隔は前の動画が終わってから次の動画が始まるまでの時間です。";

/** 画面上の 1 行。まだ保存していない追加分は itemId が null */
type Entry = Omit<PlaylistEntry, "itemId"> & { key: string; itemId: string | null };

type Notice = { tone: "info" | "error"; text: string; reload?: boolean };

export function PlaylistEditor({ data, devices }: { data: VideosPageData; devices: DeviceOption[] }) {
  const [notice, setNotice] = useState<Notice | null>(null);
  // 保存後の読み直しで revision が変わると、フォームを最新の内容で作り直す
  const formKey = `${data.settings.revision}:${data.playlist?.revision ?? "-"}`;
  return (
    <div className={styles.videosGrid}>
      <VideosForm key={formKey} data={data} devices={devices} notice={notice} setNotice={setNotice} />
    </div>
  );
}

function toEntries(items: PlaylistEntry[]): Entry[] {
  return items.map((item) => ({ ...item, key: item.itemId }));
}

function VideosForm({
  data,
  devices,
  notice,
  setNotice,
}: {
  data: VideosPageData;
  devices: DeviceOption[];
  notice: Notice | null;
  setNotice: (n: Notice | null) => void;
}) {
  const router = useRouter();
  const [settings, setSettings] = useState<VideoSettingsValues>(data.settings);
  const [entries, setEntries] = useState<Entry[]>(() => toEntries(data.playlist?.items ?? []));
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const newKey = useRef(0);

  const playlist = data.playlist;
  const baseline = toEntries(playlist?.items ?? []);
  const playlistDirty =
    entries.length !== baseline.length || entries.some((e, i) => e.itemId === null || e.itemId !== baseline[i]?.itemId);
  const settingsDirty =
    settings.enabled !== data.settings.enabled ||
    settings.intervalMinutes !== data.settings.intervalMinutes ||
    settings.mode !== data.settings.mode;
  const dirty = playlistDirty || settingsDirty;
  const inList = new Set(entries.map((e) => e.mediaId));

  const change = (patch: Partial<VideoSettingsValues>) => {
    setSettings((s) => ({ ...s, ...patch }));
    setNotice(null);
  };

  const move = (from: number, to: number) => {
    if (to < 0 || to >= entries.length || from === to) return;
    setEntries((prev) => {
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
    setNotice(null);
  };

  const add = (video: VideoLibraryItem) => {
    newKey.current += 1;
    setEntries((prev) => [
      ...prev,
      {
        key: `new-${newKey.current}`,
        itemId: null,
        mediaId: video.mediaId,
        name: video.name,
        durationSeconds: video.durationSeconds,
        thumbnailUrl: video.thumbnailUrl,
      },
    ]);
    setNotice(null);
  };

  // 実際のサイネージでこの動画を画面いっぱいに流す（2026-09-25 ユーザー指示）。保存済みの再生リストにある動画だけ
  const [testing, startTesting] = useTransition();
  const testPlay = (entry: Entry) =>
    startTesting(async () => {
      const result = await requestTestPlayAction(data.deviceId, entry.mediaId);
      setNotice(
        result.ok
          ? { tone: "info", text: `「${entry.name}」をサイネージで再生します（数秒で始まります）` }
          : { tone: "error", text: result.error.message },
      );
    });

  const removeEntry = (key: string) => {
    setEntries((prev) => prev.filter((e) => e.key !== key));
    setNotice(null);
  };

  const onGripKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      move(index, index - 1);
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      move(index, index + 1);
    }
  };

  const save = () => {
    setNotice(null);
    startTransition(async () => {
      const result = await saveDevicePlaybackAction(data.deviceId, {
        settings: {
          revision: data.settings.revision,
          enabled: settings.enabled,
          intervalMinutes: settings.intervalMinutes,
          mode: settings.mode,
          volume: data.settings.volume,
        },
        playlist: playlist ? { revision: playlist.revision, mediaIds: entries.map((e) => e.mediaId) } : null,
      });
      if (result.ok) {
        setNotice({ tone: "info", text: "保存しました。次の同期でサイネージに反映されます" });
        router.refresh();
      } else if (result.error.code === "conflict") {
        setNotice({
          tone: "error",
          text: "他の人が先に更新しました。最新の内容を読み込んでから、もう一度変更してください",
          reload: true,
        });
      } else {
        setNotice({ tone: "error", text: result.error.message });
      }
    });
  };

  const reload = () => {
    setNotice(null);
    router.refresh();
  };

  return (
    <>
      <section className={`${admin.card} ${styles.settingsCard}`} aria-label="定期動画の設定">
        <div className={admin.cardHeadRow}>
          <h2 className={admin.cardTitle}>定期動画の設定（ルーティン再生）</h2>
          <button
            type="button"
            role="switch"
            aria-checked={settings.enabled}
            aria-label="定期動画"
            className={admin.toggle}
            disabled={pending}
            onClick={() => change({ enabled: !settings.enabled })}
          >
            {settings.enabled ? "ON" : "OFF"}
          </button>
          <span title={HELP} aria-label={HELP} role="img" style={{ display: "inline-flex" }}>
            <CircleHelp className={admin.helpIcon} strokeWidth={2} aria-hidden />
          </span>
        </div>
        <p className={`${admin.cardSub} ${styles.settingsSub}`}>設定した間隔で、イベントの合間に動画を再生します。</p>

        <div className={`${styles.fieldRow} ${styles.fieldRowFirst}`}>
          <p className={styles.fieldName} id="interval-label">
            動画を流す間隔
          </p>
          <select
            className={`${admin.select} ${styles.intervalSelect}`}
            aria-labelledby="interval-label"
            value={settings.intervalMinutes}
            disabled={pending}
            onChange={(e) => change({ intervalMinutes: Number(e.target.value) })}
          >
            {VIDEO_INTERVAL_MINUTES.map((m) => (
              <option key={m} value={m}>
                {m}分ごと
              </option>
            ))}
          </select>
          <p className={styles.fieldNote}>前の動画が終わってから次の動画が始まるまでの時間です</p>
        </div>

        <div className={`${styles.fieldRow} ${styles.fieldRowTop}`}>
          <p className={styles.fieldName}>
            再生する動画
            <span className={styles.fieldCount}>
              {entries.length} / {MAX_VIDEOS} 本
            </span>
          </p>
          <div className={styles.playlistArea}>
            {!playlist ? (
              <p className={styles.playlistEmpty}>この端末には再生する動画のリストがありません。管理者にお問い合わせください。</p>
            ) : entries.length === 0 ? (
              <p className={styles.playlistEmpty}>動画がまだありません。右の「動画を追加」から選んでください。</p>
            ) : (
              <ol className={styles.playlist} aria-label="再生する動画（ドラッグで並べ替え）">
                {entries.map((entry, index) => (
                  <li
                    key={entry.key}
                    className={styles.playlistItem}
                    data-dragging={dragKey === entry.key ? "true" : undefined}
                    draggable={!pending}
                    onDragStart={(e) => {
                      setDragKey(entry.key);
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", entry.key);
                    }}
                    onDragOver={(e) => {
                      if (dragKey === null) return;
                      e.preventDefault();
                      const from = entries.findIndex((x) => x.key === dragKey);
                      if (from !== index) move(from, index);
                    }}
                    onDrop={(e) => e.preventDefault()}
                    onDragEnd={() => setDragKey(null)}
                  >
                    <button
                      type="button"
                      className={styles.grip}
                      aria-label={`${entry.name} の順番（上下キーで移動）`}
                      disabled={pending}
                      onKeyDown={(e) => onGripKey(e, index)}
                    >
                      <GripVertical size={18} strokeWidth={2} aria-hidden />
                    </button>
                    <span className={styles.order}>{index + 1}</span>
                    <Thumb url={entry.thumbnailUrl} />
                    <div className={styles.playlistText}>
                      <p className={styles.playlistName} title={entry.name}>
                        {entry.name}
                      </p>
                      <p className={styles.playlistDuration}>
                        {formatDuration(entry.durationSeconds)}
                        {entry.itemId === null ? <span className={styles.unsaved}>未保存</span> : null}
                      </p>
                    </div>
                    <button
                      type="button"
                      className={styles.removeButton}
                      disabled={pending || testing || entry.itemId === null}
                      title={entry.itemId === null ? "保存してから再生できます" : "実際のサイネージで、この動画を画面いっぱいに流します"}
                      onClick={() => testPlay(entry)}
                    >
                      <Play size={12} fill="currentColor" strokeWidth={0} aria-hidden />
                      サイネージで再生
                    </button>
                    <button
                      type="button"
                      className={styles.removeButton}
                      disabled={pending}
                      onClick={() => removeEntry(entry.key)}
                    >
                      <X size={13} strokeWidth={2.4} aria-hidden />
                      外す
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>

        <div className={styles.fieldRow}>
          <p className={styles.fieldName}>再生順</p>
          <div className={styles.radios} role="radiogroup" aria-label="再生順">
            <Radio
              name="mode"
              label="順番"
              hint="（最後の動画の後、最初に戻ります）"
              checked={settings.mode === "sequence"}
              disabled={pending}
              onChange={() => change({ mode: "sequence" })}
            />
            <Radio
              name="mode"
              label="ランダム"
              checked={settings.mode === "random"}
              disabled={pending}
              onChange={() => change({ mode: "random" })}
            />
          </div>
        </div>

        <div className={styles.fieldRow}>
          <p className={styles.fieldName}>動画終了後</p>
          <div className={styles.radios}>
            <Radio name="after" label="イベント画面に戻る" checked disabled fixed onChange={() => undefined} />
          </div>
        </div>

        <div className={styles.saveRow}>
          {notice ? (
            <p className={styles.saveNotice} data-tone={notice.tone} role={notice.tone === "error" ? "alert" : "status"}>
              {notice.tone === "error" ? (
                <CircleAlert size={15} strokeWidth={2.2} aria-hidden />
              ) : (
                <Check size={15} strokeWidth={2.6} aria-hidden />
              )}
              <span>{notice.text}</span>
              {notice.reload ? (
                <button type="button" className={styles.reloadButton} onClick={reload}>
                  最新の内容を読み込む
                </button>
              ) : null}
            </p>
          ) : dirty ? (
            <p className={styles.saveHint}>変更は「保存する」を押すまで反映されません</p>
          ) : null}
          <button type="button" className={styles.saveButton} disabled={pending || !dirty} onClick={save}>
            {pending ? "保存しています…" : "保存する"}
          </button>
        </div>
      </section>

      <LibraryCard
        library={data.library}
        inList={inList}
        canAdd={playlist !== null && !pending && entries.length < MAX_VIDEOS}
        full={entries.length >= MAX_VIDEOS}
        onAdd={add}
        showDeviceHint={devices.length > 1}
      />
    </>
  );
}

function Thumb({ url }: { url: string | null }) {
  return (
    <div className={`${admin.videoThumb} ${styles.thumb}`}>
      {url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={url} alt="" loading="lazy" />
      ) : null}
      <span className={admin.playMark} aria-hidden>
        <Play size={11} fill="currentColor" strokeWidth={0} />
      </span>
    </div>
  );
}

function Radio({
  name,
  label,
  hint,
  checked,
  disabled,
  fixed,
  onChange,
}: {
  name: string;
  label: string;
  hint?: string;
  checked: boolean;
  disabled?: boolean;
  /** 選べない（表示のみ）。薄くしない */
  fixed?: boolean;
  onChange: () => void;
}) {
  return (
    <label className={styles.radio} data-fixed={fixed ? "true" : undefined}>
      <input type="radio" name={name} checked={checked} disabled={disabled} onChange={onChange} />
      <span className={styles.radioMark} aria-hidden />
      <span>
        {label}
        {hint ? <span className={styles.radioHint}>{hint}</span> : null}
      </span>
    </label>
  );
}

function LibraryCard({
  library,
  inList,
  canAdd,
  full,
  onAdd,
  showDeviceHint,
}: {
  library: VideoLibraryItem[];
  inList: Set<string>;
  canAdd: boolean;
  /** 再生する動画が上限（3 本）に達している */
  full: boolean;
  onAdd: (video: VideoLibraryItem) => void;
  showDeviceHint: boolean;
}) {
  return (
    <section className={`${admin.card} ${styles.addCard}`} aria-label="動画を追加">
      <div className={admin.cardHeadRow}>
        <h2 className={admin.cardTitleSmall}>動画を追加</h2>
        <Link href="/admin/media" className={admin.textLink}>
          動画をアップロード
        </Link>
      </div>
      <p className={`${admin.cardSub} ${styles.addSub}`}>
        {showDeviceHint ? "選んでいる端末の再生リストに追加します。" : "アップロード済みの動画から選びます。"}
        {full ? ` 再生する動画は ${MAX_VIDEOS} 本までです。入れ替えるときは、左のリストから外してから追加してください。` : null}
      </p>
      {library.length === 0 ? (
        <div className={`${admin.empty} ${styles.addEmpty}`}>
          <p>動画がまだありません。</p>
          <Link href="/admin/media" className={admin.emptyLink}>
            動画・メディアでアップロードする
          </Link>
        </div>
      ) : (
        <ul className={styles.addList}>
          {library.map((video) => {
            const added = inList.has(video.mediaId);
            const tooLong = isVideoTooLong(video.durationSeconds);
            return (
              <li key={video.mediaId} className={styles.addItem} data-disabled={video.playable && !tooLong ? undefined : "true"}>
                <Thumb url={video.thumbnailUrl} />
                <div className={styles.playlistText}>
                  <p className={styles.playlistName} title={video.name}>
                    {video.name}
                  </p>
                  <p className={styles.playlistDuration}>{formatDuration(video.durationSeconds)}</p>
                </div>
                {tooLong ? (
                  <p className={styles.addReason}>{MAX_VIDEO_SECONDS} 秒を超えているため使えません</p>
                ) : video.playable ? (
                  <button
                    type="button"
                    className={styles.addButton}
                    disabled={!canAdd || added}
                    onClick={() => onAdd(video)}
                  >
                    {added ? (
                      "追加済み"
                    ) : (
                      <>
                        <Plus size={14} strokeWidth={2.4} aria-hidden />
                        追加
                      </>
                    )}
                  </button>
                ) : (
                  <p className={styles.addReason}>{UNPLAYABLE_MESSAGE}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
