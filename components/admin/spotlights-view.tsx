"use client";

/**
 * メンバー紹介（Staff 以上）。一覧・追加・編集・削除。サイネージの MEMBER SPOTLIGHT には「サイネージに出す」が ON の人だけを、
 * 登録順に 1 人ずつ切り替えて出す（lib/config-builder.ts・lib/display-rules.ts）。
 * 一覧と保存の流れ（revision 競合のときは知らせて読み込み直す）はお知らせ（notices-view.tsx）にそろえる。
 * 一覧は検索・あ行・か行… の絞り込み・名前順ができる（2026-09-27 ユーザー指示。行の決め方は kana-row.ts）。
 * 絞り込みの見た目はイベント管理（events-manager.tsx）の状態の絞り込みと検索欄にそろえる。
 */
import { Pencil, Plus, Search, Trash2, UserRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createSpotlightAction, deleteSpotlightAction, updateSpotlightAction } from "@/app/admin/_actions/spotlights";
import type { SpotlightRow } from "@/lib/services/spotlights";
import { SPOTLIGHT_SUBMISSIONS_PENDING_PATH, type SpotlightSubmissionDetail } from "@/lib/spotlight-submissions";
import admin from "./admin.module.css";
import events from "./events.module.css";
import { KANA_ROWS, kanaRowOf, normalizeForSearch, sortByReading, type KanaRow } from "./kana-row";
import { mediaThumbnailUrl } from "./media-upload-field";
import styles from "./settings.module.css";
import { SpotlightSubmissionsView } from "./spotlight-submissions-view";
import { SpotlightRegistrationShare } from "./spotlight-registration-share";
import {
  SpotlightForm,
  emptySpotlightForm,
  spotlightFormError,
  toSpotlightForm,
  toSpotlightInput,
  type SpotlightFormState,
} from "./spotlight-form";

const SAVED_MESSAGE = "保存しました。サイネージには 30 秒以内に反映されます。";

type Sort = "registered" | "kana";

/** お名前・ふりがな・会社名・肩書き・タグのどれかに含まれるか。needle は normalizeForSearch 済み */
function matches(s: SpotlightRow, needle: string): boolean {
  return [s.personName, s.personNameKana, s.companyName, s.role, ...s.tags].some(
    (v) => v !== null && normalizeForSearch(v).includes(needle),
  );
}

export function SpotlightsView({
  spotlights,
  submissions = [],
  initialTab = "published",
}: {
  spotlights: SpotlightRow[];
  submissions?: SpotlightSubmissionDetail[];
  /** ベルの知らせ（?tab=pending）から来たときは「確認待ち」を開く */
  initialTab?: "published" | "pending";
}) {
  const [tab, setTab] = useState<"published" | "pending">(initialTab);
  // 同じ画面を開いたままベルの知らせを押したときも、URL（?tab=pending）に合わせて切り替える
  const [urlTab, setUrlTab] = useState(initialTab);
  if (urlTab !== initialTab) {
    setUrlTab(initialTab);
    setTab(initialTab);
  }
  const [form, setForm] = useState<SpotlightFormState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [pending, startTransition] = useTransition();
  const [query, setQuery] = useState("");
  const [row, setRow] = useState<KanaRow | "all">("all");
  const [sort, setSort] = useState<Sort>("registered");
  const router = useRouter();
  const selectTab = (next: "published" | "pending") => {
    setTab(next);
    router.replace(next === "pending" ? SPOTLIGHT_SUBMISSIONS_PENDING_PATH : "/admin/spotlights", { scroll: false });
  };

  // 行ごとの人数は検索に当たった人で数える（どの行に当たりがあるか分かるように）
  const needle = normalizeForSearch(query).trim();
  const searched = needle === "" ? spotlights : spotlights.filter((s) => matches(s, needle));
  const inRow = row === "all" ? searched : searched.filter((s) => kanaRowOf(s) === row);
  const shown = sort === "kana" ? sortByReading(inRow) : inRow;

  const openNew = () => {
    setForm(emptySpotlightForm());
    setError(null);
    setSuccess(false);
  };
  const openEdit = (s: SpotlightRow) => {
    setForm(toSpotlightForm(s));
    setError(null);
    setSuccess(false);
  };
  const closeForm = () => {
    setForm(null);
    setError(null);
  };
  // 最新の入力に重ねる。閉じたあとに届いたアップロードの結果では入力欄を開き直さない
  const patchForm = (patch: Partial<SpotlightFormState>) => setForm((f) => (f ? { ...f, ...patch } : f));

  const save = () => {
    if (!form) return;
    const invalid = spotlightFormError(form);
    if (invalid) {
      setError(invalid);
      return;
    }
    const input = toSpotlightInput(form);
    startTransition(async () => {
      const result = form.id
        ? await updateSpotlightAction(form.id, { ...input, revision: form.revision })
        : await createSpotlightAction(input);
      if (result.error) {
        setError(result.error.message);
        if (result.error.code === "conflict") router.refresh();
        return;
      }
      setError(null);
      setSuccess(true);
      setForm(null);
      router.refresh();
    });
  };

  const remove = (s: SpotlightRow) => {
    if (!window.confirm(`「${s.personName}さん」を削除します。よろしいですか？`)) return;
    startTransition(async () => {
      const result = await deleteSpotlightAction(s.id);
      if (result.error) {
        setError(result.error.message);
        return;
      }
      setError(null);
      router.refresh();
    });
  };

  return (
    <div className={styles.page}>
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.pageTitle}>メンバー紹介</h1>
          <p className={styles.pageDesc}>サイネージの右上の MEMBER SPOTLIGHT に、登録順に 1 人ずつ切り替えて出します。</p>
        </div>
        {form || tab !== "published" ? null : (
          <button type="button" className={styles.primaryButton} onClick={openNew}>
            <Plus size={18} strokeWidth={2.4} aria-hidden />
            メンバーを追加
          </button>
        )}
      </div>

      <SpotlightRegistrationShare />

      <div className={`${admin.chips} ${styles.kanaChips}`} role="group" aria-label="メンバー紹介の表示切り替え" style={{ marginLeft: 0, marginTop: 0 }}>
        <button type="button" className={admin.chip} aria-pressed={tab === "published"} onClick={() => selectTab("published")}>
          掲載メンバー
        </button>
        <button type="button" className={admin.chip} aria-pressed={tab === "pending"} onClick={() => selectTab("pending")}>
          確認待ち（{submissions.length}件）
        </button>
      </div>

      {tab === "pending" ? (
        <SpotlightSubmissionsView submissions={submissions} />
      ) : (
        <>
          {form ? (
            // 人ごとに作り直し、前の人の写真・ロゴのアップロード結果が入らないようにする（spotlight-form.tsx）
            <SpotlightForm
              key={form.id ?? "new"}
              form={form}
              onChange={patchForm}
              error={error}
              pending={pending}
              onSave={save}
              onCancel={closeForm}
            />
          ) : null}

          {error && !form ? (
            <p className={styles.formError} role="alert">
              {error}
            </p>
          ) : null}
          {success ? <p className={styles.formSuccess}>{SAVED_MESSAGE}</p> : null}

          <section className={styles.panel} aria-label="メンバー紹介一覧">
            <div className={styles.listTools}>
              <h2 className={styles.panelTitle}>メンバー紹介一覧</h2>
              <label className={events.search}>
                <Search size={17} strokeWidth={2.2} aria-hidden />
                <input
                  type="search"
                  placeholder="お名前・会社名・タグで探す"
                  aria-label="メンバーを検索"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </label>
              <select
                className={styles.select}
                aria-label="並び順"
                value={sort}
                onChange={(e) => setSort(e.target.value === "kana" ? "kana" : "registered")}
              >
                <option value="registered">登録順</option>
                <option value="kana">名前順（あいうえお）</option>
              </select>
            </div>
            <div className={`${admin.chips} ${styles.kanaChips}`} role="group" aria-label="名前の行で絞り込む">
              <button type="button" className={admin.chip} aria-pressed={row === "all"} onClick={() => setRow("all")}>
                すべて
              </button>
              {KANA_ROWS.map((r) => {
                const count = searched.filter((s) => kanaRowOf(s) === r).length;
                return (
                  <button
                    key={r}
                    type="button"
                    className={admin.chip}
                    aria-pressed={row === r}
                    disabled={count === 0}
                    onClick={() => setRow(r)}
                  >
                    {r === "その他" ? r : `${r}行`} {count}
                  </button>
                );
              })}
            </div>
            <p className={styles.hint} style={{ marginTop: 8 }}>
              登録順は、サイネージに出す順番と同じです。
            </p>
            {spotlights.length === 0 ? (
              <div className={styles.empty}>
                <p>メンバー紹介はまだありません。</p>
              </div>
            ) : shown.length === 0 ? (
              <div className={styles.empty}>
                <p>該当するメンバーはいません</p>
              </div>
            ) : (
              <ul className={styles.list}>
                {shown.map((s) => (
                  <li key={s.id} className={styles.listRow}>
                    {s.photoMediaId ? (
                      // 縦長の写真は顔が上の方にあるので、横長の枠では上寄りを見せる
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        className={styles.thumb}
                        style={{ objectPosition: "50% 20%" }}
                        src={mediaThumbnailUrl(s.photoMediaId)}
                        alt=""
                      />
                    ) : (
                      <div className={`${styles.thumb} ${styles.thumbEmpty}`} aria-hidden>
                        <UserRound size={20} strokeWidth={1.6} />
                      </div>
                    )}
                    <div className={styles.rowMain}>
                      <p className={styles.rowTitle}>{s.personName}さん</p>
                      <p className={styles.rowBody}>{s.role ? `${s.companyName} / ${s.role}` : s.companyName}</p>
                    </div>
                    <span className={`${styles.badge} ${s.enabled ? styles.badgeOn : styles.badgeOff}`}>
                      {s.enabled ? "表示する" : "表示しない"}
                    </span>
                    <p className={styles.scheduleText}>{s.tags.join("・")}</p>
                    <div className={styles.rowActions}>
                      <button type="button" className={styles.secondaryButton} disabled={pending} onClick={() => openEdit(s)}>
                        <Pencil size={14} strokeWidth={2.2} aria-hidden />
                        編集
                      </button>
                      <button
                        type="button"
                        className={`${styles.secondaryButton} ${styles.dangerButton}`}
                        disabled={pending}
                        onClick={() => remove(s)}
                      >
                        <Trash2 size={14} strokeWidth={2.2} aria-hidden />
                        削除
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
