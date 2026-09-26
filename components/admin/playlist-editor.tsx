"use client";

/**
 * 定期動画の設定（要件定義書 14 節）。ON/OFF・間隔・再生リスト（並べ替え・追加・外す）・再生順を
 * 画面上で変えてから「保存する」でまとめて保存する。
 * 再生リストには写真のスライドショーも 1 つ入れられる（写真 1〜3 枚・写真ごとの秒数・合計 30 秒まで。
 * 2026-09-27 ユーザー指示）。写真と秒数はリストのすぐ下の欄で変える。行の中に広げたりボタンを足したりしないのは、
 * 行の高さがそろっていないとドラッグの並べ替えで行が行き来し、列が増えると幅 1280px で行の文字が入らないため。
 *
 * 保存は saveDevicePlaybackAction の 1 回で、プレイリストの中身（動画とスライドショーの並び）と再生設定を
 * 1 トランザクションで丸ごと保存する。revision が合わなければ何も書かれず、入力は画面に残る。
 */
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  CircleHelp,
  GripVertical,
  Images,
  Play,
  Plus,
  X,
} from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition, type KeyboardEvent } from "react";
import { requestTestPlayAction, saveDevicePlaybackAction } from "@/app/admin/_actions/playback";
import { MAX_SLIDES, MAX_SLIDESHOW_SECONDS, SLIDE_SECONDS_OPTIONS, VIDEO_INTERVAL_MINUTES } from "@/lib/config-schema";
import { MAX_VIDEO_SECONDS, MAX_VIDEOS, isVideoTooLong } from "@/lib/file-sniff";
import admin from "./admin.module.css";
import { formatDuration } from "./format";
import { MediaUploadField } from "./media-upload-field";
import {
  UNPLAYABLE_MESSAGE,
  type DeviceOption,
  type PlaylistEntry,
  type PlaylistVideoEntry,
  type VideoLibraryItem,
  type VideosPageData,
  type VideoSettingsValues,
} from "./media-types";
import styles from "./media.module.css";

const HELP =
  "イベント表示の合間に、設定した間隔で動画またはスライドショーを 1 つずつ全画面で流します。" +
  `動画は ${MAX_VIDEOS} 本まで、スライドショーは 1 つ（写真 ${MAX_SLIDES} 枚まで・合計 ${MAX_SLIDESHOW_SECONDS} 秒まで）入れられます。` +
  "間隔は前の動画やスライドショーが終わってから、次が始まるまでの時間です。";

const SLIDESHOW_NAME = "スライドショー";
/** 写真の欄を足したときの秒数（3 枚ともこのままで、ちょうど合計 30 秒に収まる） */
const DEFAULT_SLIDE_SECONDS = 10;
const IMAGE_HINT = "JPEG・PNG・WebP（20MBまで）";
const SLIDE_EDITOR_ID = "slideshow-editor";

/** スライドショーの写真の欄。まだ写真を選んでいない欄は photo が null で、保存するときは入れない */
type SlideSlot = { key: string; photo: { mediaId: string; previewUrl: string } | null; durationSeconds: number };

type VideoRow = Omit<PlaylistVideoEntry, "itemId"> & { key: string; itemId: string | null };
type SlideshowRow = { kind: "slideshow"; key: string; itemId: string | null; slides: SlideSlot[] };
/** 画面上の 1 行。まだ保存していない追加分は itemId が null */
type Entry = VideoRow | SlideshowRow;

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
  return items.map(
    (item): Entry =>
      item.kind === "video"
        ? { ...item, key: item.itemId }
        : {
            kind: "slideshow",
            key: item.itemId,
            itemId: item.itemId,
            slides: item.slides.map((slide, i) => ({
              key: `${item.itemId}:${i}`,
              photo: { mediaId: slide.mediaId, previewUrl: slide.thumbnailUrl },
              durationSeconds: slide.durationSeconds,
            })),
          },
  );
}

const rowName = (entry: Entry) => (entry.kind === "video" ? entry.name : SLIDESHOW_NAME);

/** 写真を選んだ欄だけ（保存するのはこれだけ） */
const chosenSlides = (slides: SlideSlot[]) =>
  slides.flatMap((s) => (s.photo ? [{ key: s.key, ...s.photo, durationSeconds: s.durationSeconds }] : []));

const totalSeconds = (slides: SlideSlot[]) => chosenSlides(slides).reduce((sum, s) => sum + s.durationSeconds, 0);

/** 保存される中身（写真・並び・秒数）が同じか。写真の無い欄は保存しないので比べない */
function sameSlides(a: SlideSlot[], b: SlideSlot[]): boolean {
  const x = chosenSlides(a);
  const y = chosenSlides(b);
  return x.length === y.length && x.every((s, i) => s.mediaId === y[i].mediaId && s.durationSeconds === y[i].durationSeconds);
}

/** スライドショーを保存できない理由（無ければ null）。サーバーでも同じ規則で確かめる */
function slideshowProblem(slides: SlideSlot[]): string | null {
  if (chosenSlides(slides).length === 0) {
    return "スライドショーの写真を 1 枚以上選んでください（写真を入れないときは、スライドショーを外してください）";
  }
  const total = totalSeconds(slides);
  if (total > MAX_SLIDESHOW_SECONDS) {
    return `スライドショーは合計 ${MAX_SLIDESHOW_SECONDS} 秒までです（今は ${total} 秒）。写真の秒数を短くしてください`;
  }
  return null;
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
  const [slidesOpen, setSlidesOpen] = useState(false);
  // 写真をアップロード中の欄（key）。終わるまでは保存できない
  const [uploadingSlots, setUploadingSlots] = useState<ReadonlySet<string>>(() => new Set());
  const [pending, startTransition] = useTransition();
  const newKey = useRef(0);

  const playlist = data.playlist;
  const baseline = toEntries(playlist?.items ?? []);
  const playlistDirty =
    entries.length !== baseline.length ||
    entries.some((e, i) => {
      const saved = baseline[i];
      if (e.itemId === null || e.itemId !== saved?.itemId) return true;
      // 同じスライドショーでも、写真・並び・秒数を変えていれば変更に数える
      return e.kind === "slideshow" && saved.kind === "slideshow" && !sameSlides(e.slides, saved.slides);
    });
  const settingsDirty =
    settings.enabled !== data.settings.enabled ||
    settings.intervalMinutes !== data.settings.intervalMinutes ||
    settings.mode !== data.settings.mode;
  const dirty = playlistDirty || settingsDirty;
  const videoCount = entries.filter((e) => e.kind === "video").length;
  const inList = new Set(entries.flatMap((e) => (e.kind === "video" ? [e.mediaId] : [])));
  const slideshow = entries.find((e): e is SlideshowRow => e.kind === "slideshow");
  const problem = slideshow ? slideshowProblem(slideshow.slides) : null;
  const uploading = slideshow?.slides.some((s) => uploadingSlots.has(s.key)) ?? false;

  /** 保存済みのまま（追加したばかりでも、中身を変えてもいない）か。サイネージで試せるのはこの行だけ */
  const isSaved = (entry: Entry) => {
    if (entry.itemId === null) return false;
    if (entry.kind === "video") return true;
    const saved = baseline.find((b) => b.itemId === entry.itemId);
    return saved?.kind === "slideshow" && sameSlides(entry.slides, saved.slides);
  };

  const nextKey = (prefix: string) => {
    newKey.current += 1;
    return `${prefix}-${newKey.current}`;
  };

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
    const key = nextKey("new");
    setEntries((prev) => [
      ...prev,
      {
        kind: "video",
        key,
        itemId: null,
        mediaId: video.mediaId,
        name: video.name,
        durationSeconds: video.durationSeconds,
        thumbnailUrl: video.thumbnailUrl,
      },
    ]);
    setNotice(null);
  };

  const newSlot = (): SlideSlot => ({ key: nextKey("slide"), photo: null, durationSeconds: DEFAULT_SLIDE_SECONDS });

  // スライドショーを 1 つ足す（2026-09-27 ユーザー指示）。すぐ写真を選べるよう、写真の欄を 1 つ開いた状態で始める
  const addSlideshow = () => {
    const entry: SlideshowRow = { kind: "slideshow", key: nextKey("new"), itemId: null, slides: [newSlot()] };
    setEntries((prev) => [...prev, entry]);
    setSlidesOpen(true);
    setNotice(null);
  };

  /** スライドショー（再生リストに 1 つまで）の写真の欄を変える */
  const changeSlides = (update: (slides: SlideSlot[]) => SlideSlot[]) => {
    setEntries((prev) => prev.map((e) => (e.kind === "slideshow" ? { ...e, slides: update(e.slides) } : e)));
    setNotice(null);
  };
  const patchSlot = (key: string, patch: Partial<SlideSlot>) =>
    changeSlides((slides) => slides.map((s) => (s.key === key ? { ...s, ...patch } : s)));
  const addSlot = () => {
    const slot = newSlot();
    changeSlides((slides) => [...slides, slot]);
  };
  const removeSlot = (key: string) => changeSlides((slides) => slides.filter((s) => s.key !== key));
  const setSlotUploading = (key: string, busy: boolean) =>
    setUploadingSlots((prev) => {
      const next = new Set(prev);
      if (busy) next.add(key);
      else next.delete(key);
      return next;
    });

  // 実際のサイネージでこの動画を画面いっぱいに流す（2026-09-25 ユーザー指示）。保存済みの再生リストにあるものだけ。
  // スライドショーは 1 枚目の写真の mediaId で指す（再生リストの項目の media_id と同じ）
  const [testing, startTesting] = useTransition();
  const testPlay = (entry: Entry) => {
    const mediaId = entry.kind === "video" ? entry.mediaId : chosenSlides(entry.slides)[0].mediaId;
    startTesting(async () => {
      const result = await requestTestPlayAction(data.deviceId, mediaId);
      setNotice(
        result.ok
          ? { tone: "info", text: `「${rowName(entry)}」をサイネージで再生します（数秒で始まります）` }
          : { tone: "error", text: result.error.message },
      );
    });
  };

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
        playlist: playlist
          ? {
              revision: playlist.revision,
              // 画面の並びのまま。スライドショーは写真を選んだ欄だけを送る
              items: entries.map((e) =>
                e.kind === "video"
                  ? { kind: "video", mediaId: e.mediaId }
                  : {
                      kind: "slideshow",
                      slides: chosenSlides(e.slides).map((s) => ({ mediaId: s.mediaId, durationSeconds: s.durationSeconds })),
                    },
              ),
            }
          : null,
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
        <p className={`${admin.cardSub} ${styles.settingsSub}`}>
          設定した間隔で、イベントの合間に動画やスライドショーを再生します。
        </p>

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
          <p className={styles.fieldNote}>前の動画やスライドショーが終わってから、次が始まるまでの時間です</p>
        </div>

        <div className={`${styles.fieldRow} ${styles.fieldRowTop}`}>
          <p className={styles.fieldName}>
            再生リスト
            <span className={styles.fieldCount}>
              動画 {videoCount} / {MAX_VIDEOS} 本
            </span>
            <span className={styles.fieldCount}>スライドショー {slideshow ? 1 : 0} / 1</span>
          </p>
          <div className={styles.playlistArea}>
            {!playlist ? (
              <p className={styles.playlistEmpty}>この端末には再生する動画のリストがありません。管理者にお問い合わせください。</p>
            ) : entries.length === 0 ? (
              <p className={styles.playlistEmpty}>
                まだ何も入っていません。右の「動画を追加」から動画を選ぶか、「スライドショーを追加」で写真を入れてください。
              </p>
            ) : (
              <>
                <ol className={styles.playlist} aria-label="再生リスト（ドラッグで並べ替え）">
                  {entries.map((entry, index) => {
                    const name = rowName(entry);
                    const saved = isSaved(entry);
                    return (
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
                          aria-label={`${name} の順番（上下キーで移動）`}
                          disabled={pending}
                          onKeyDown={(e) => onGripKey(e, index)}
                        >
                          <GripVertical size={18} strokeWidth={2} aria-hidden />
                        </button>
                        <span className={styles.order}>{index + 1}</span>
                        {entry.kind === "video" ? <Thumb url={entry.thumbnailUrl} /> : <SlideThumbs slides={entry.slides} />}
                        <div className={styles.playlistText}>
                          <p className={styles.playlistName} title={name}>
                            {name}
                          </p>
                          <p className={styles.playlistDuration}>
                            {entry.kind === "video" ? (
                              formatDuration(entry.durationSeconds)
                            ) : (
                              <span className={styles.slideSummary}>
                                {`写真 ${chosenSlides(entry.slides).length} 枚・合計 ${totalSeconds(entry.slides)} 秒`}
                              </span>
                            )}
                            {saved ? null : <span className={styles.unsaved}>未保存</span>}
                          </p>
                        </div>
                        <button
                          type="button"
                          className={styles.removeButton}
                          disabled={pending || testing || !saved}
                          title={
                            saved
                              ? `実際のサイネージで、この${entry.kind === "video" ? "動画" : "スライドショー"}を画面いっぱいに流します`
                              : "保存してから再生できます"
                          }
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
                    );
                  })}
                </ol>
                {slideshow ? (
                  <SlideshowEditor
                    slides={slideshow.slides}
                    open={slidesOpen}
                    onToggle={() => setSlidesOpen((open) => !open)}
                    disabled={pending}
                    onPatch={patchSlot}
                    onAdd={addSlot}
                    onRemove={removeSlot}
                    onUploading={setSlotUploading}
                  />
                ) : null}
              </>
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
          ) : problem ? (
            <p className={styles.saveHint} data-tone="error" role="alert">
              {problem}
            </p>
          ) : dirty ? (
            <p className={styles.saveHint}>変更は「保存する」を押すまで反映されません</p>
          ) : null}
          <button
            type="button"
            className={styles.saveButton}
            disabled={pending || uploading || !dirty || problem !== null}
            onClick={save}
          >
            {pending ? "保存しています…" : "保存する"}
          </button>
        </div>
      </section>

      <div className={styles.sideColumn}>
        <SlideshowCard canAdd={playlist !== null && !pending} exists={slideshow !== undefined} onAdd={addSlideshow} />
        <LibraryCard
          library={data.library}
          inList={inList}
          canAdd={playlist !== null && !pending && videoCount < MAX_VIDEOS}
          full={videoCount >= MAX_VIDEOS}
          onAdd={add}
          showDeviceHint={devices.length > 1}
        />
      </div>
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

/** スライドショーの行のサムネイル。写真を横に並べる（まだ写真が無ければ印だけ） */
function SlideThumbs({ slides }: { slides: SlideSlot[] }) {
  const photos = chosenSlides(slides);
  return (
    <div className={`${styles.slideThumbs} ${styles.thumb}`} data-empty={photos.length === 0 ? "true" : undefined}>
      {photos.length === 0 ? (
        <Images size={18} strokeWidth={1.8} aria-hidden />
      ) : (
        photos.map((photo) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={photo.key} src={photo.previewUrl} alt="" loading="lazy" />
        ))
      )}
    </div>
  );
}

/**
 * スライドショーの写真（MAX_SLIDES 枚まで）と、写真ごとに表示する秒数の欄。
 * 写真の欄は大きいので、保存済みのスライドショーは閉じておき、合計の秒数だけをいつも出す
 */
function SlideshowEditor({
  slides,
  open,
  onToggle,
  disabled,
  onPatch,
  onAdd,
  onRemove,
  onUploading,
}: {
  slides: SlideSlot[];
  open: boolean;
  onToggle: () => void;
  disabled: boolean;
  onPatch: (key: string, patch: Partial<SlideSlot>) => void;
  onAdd: () => void;
  onRemove: (key: string) => void;
  onUploading: (key: string, busy: boolean) => void;
}) {
  const total = totalSeconds(slides);
  const over = total > MAX_SLIDESHOW_SECONDS;
  return (
    <section className={styles.slideEditor} aria-label="スライドショーの写真と秒数">
      <div className={styles.slideEditorHead}>
        <button
          type="button"
          className={styles.slideToggle}
          aria-expanded={open}
          aria-controls={SLIDE_EDITOR_ID}
          onClick={onToggle}
        >
          {open ? <ChevronDown size={16} strokeWidth={2.4} aria-hidden /> : <ChevronRight size={16} strokeWidth={2.4} aria-hidden />}
          スライドショーの写真と秒数を編集
        </button>
        <p className={styles.slideTotal} data-over={over ? "true" : undefined} aria-live="polite">
          合計 {total} / {MAX_SLIDESHOW_SECONDS} 秒
        </p>
      </div>
      {open ? (
        <div id={SLIDE_EDITOR_ID} className={styles.slideEditorBody}>
          <p className={styles.slideNote}>写真は {MAX_SLIDES} 枚まで。写真ごとに表示する秒数を選びます。</p>
          <ol className={styles.slideSlots}>
            {slides.map((slot, i) => {
              const label = `写真 ${i + 1}`;
              return (
                <li key={slot.key} className={styles.slideSlot}>
                  <MediaUploadField
                    label={label}
                    hint={IMAGE_HINT}
                    previewUrl={slot.photo?.previewUrl ?? null}
                    selectedId={slot.photo?.mediaId ?? null}
                    disabled={disabled}
                    onBusyChange={(busy) => onUploading(slot.key, busy)}
                    onChange={(mediaId, previewUrl) =>
                      onPatch(slot.key, { photo: mediaId && previewUrl ? { mediaId, previewUrl } : null })
                    }
                  />
                  <div className={styles.slideSlotFoot}>
                    <label className={styles.slideSeconds}>
                      秒数
                      <select
                        className={admin.select}
                        aria-label={`${label} の秒数`}
                        value={slot.durationSeconds}
                        disabled={disabled}
                        onChange={(e) => onPatch(slot.key, { durationSeconds: Number(e.target.value) })}
                      >
                        {SLIDE_SECONDS_OPTIONS.map((s) => (
                          <option key={s} value={s}>
                            {s} 秒
                          </option>
                        ))}
                      </select>
                    </label>
                    {slides.length > 1 ? (
                      <button
                        type="button"
                        className={styles.removeButton}
                        aria-label={`${label} の欄を消す`}
                        disabled={disabled}
                        onClick={() => onRemove(slot.key)}
                      >
                        <X size={13} strokeWidth={2.4} aria-hidden />
                        欄を消す
                      </button>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ol>
          <div className={styles.slideEditorFoot}>
            <button
              type="button"
              className={`${styles.addButton} ${styles.addWideButton}`}
              disabled={disabled || slides.length >= MAX_SLIDES}
              onClick={onAdd}
            >
              <Plus size={14} strokeWidth={2.4} aria-hidden />
              写真を追加
            </button>
            {slides.some((s) => s.photo === null) ? (
              <p className={styles.slideNote}>写真を選んでいない欄は保存しません。</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </section>
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

/** 写真のスライドショーを再生リストに足す（再生リストに 1 つまで。2026-09-27 ユーザー指示） */
function SlideshowCard({ canAdd, exists, onAdd }: { canAdd: boolean; exists: boolean; onAdd: () => void }) {
  return (
    <section className={`${admin.card} ${styles.addCard}`} aria-label="写真のスライドショー">
      <h2 className={admin.cardTitleSmall}>写真のスライドショー</h2>
      <p className={`${admin.cardSub} ${styles.addSub}`}>
        写真 1〜{MAX_SLIDES} 枚を、写真ごとに選んだ秒数で順に全画面で流します（合計 {MAX_SLIDESHOW_SECONDS} 秒まで）。
      </p>
      <button
        type="button"
        className={`${styles.addButton} ${styles.addWideButton} ${styles.addSlideshowButton}`}
        disabled={!canAdd || exists}
        onClick={onAdd}
      >
        <Plus size={14} strokeWidth={2.4} aria-hidden />
        スライドショーを追加
      </button>
      {exists ? (
        <p className={styles.addNote}>
          スライドショーは再生リストに 1 つまでです。写真や秒数は、左の「スライドショーの写真と秒数を編集」から変えられます。
        </p>
      ) : null}
    </section>
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
