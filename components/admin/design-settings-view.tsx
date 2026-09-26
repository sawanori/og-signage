"use client";

/**
 * デザイン設定（Administrator）。ハウス基本情報・イベントカテゴリの 2 つを、それぞれ独立して保存する。
 * ハウス基本情報は house_settings の revision による条件付き更新（competing edits は conflict）。
 * カテゴリは revision を持たず、保存のたびに全件を置き換える（lib/services/house.ts）。
 * メンバー情報（旧ハウスルール）の画面は 2026-09-26 ユーザー指示で外した（横型の右上はメンバー紹介。/admin/spotlights）。
 */
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { updateDesignSettingsAction, updateEventCategoriesAction } from "@/app/admin/_actions/content";
import type { EventCategoryRow, HouseSettingsRow } from "@/lib/services/house";
import { MediaUploadField, mediaThumbnailUrl } from "./media-upload-field";
import styles from "./settings.module.css";

const SAVED_MESSAGE = "保存しました。サイネージには 30 秒以内に反映されます。";

export function DesignSettingsView({
  settings,
  categories,
}: {
  settings: HouseSettingsRow;
  categories: EventCategoryRow[];
}) {
  return (
    <div className={styles.page}>
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.pageTitle}>デザイン設定</h1>
          <p className={styles.pageDesc}>サイネージに表示するハウスの情報とカテゴリの色を設定します。</p>
        </div>
      </div>
      <HouseInfoSection settings={settings} />
      <CategoriesSection categories={categories} />
    </div>
  );
}

// ---------------------------------------------------------------- ハウス基本情報

function HouseInfoSection({ settings }: { settings: HouseSettingsRow }) {
  const [houseName, setHouseName] = useState(settings.houseName);
  const [headerCopy, setHeaderCopy] = useState(settings.headerCopy ?? "");
  const [footerCopy, setFooterCopy] = useState(settings.footerCopy ?? "");
  const [footerQrUrl, setFooterQrUrl] = useState(settings.footerQrUrl ?? "");
  const [logoMediaId, setLogoMediaId] = useState(settings.logoMediaId);
  const [logoPreview, setLogoPreview] = useState<string | null>(settings.logoMediaId ? mediaThumbnailUrl(settings.logoMediaId) : null);
  const [footerImageMediaId, setFooterImageMediaId] = useState(settings.footerImageMediaId);
  const [footerImagePreview, setFooterImagePreview] = useState<string | null>(
    settings.footerImageMediaId ? mediaThumbnailUrl(settings.footerImageMediaId) : null,
  );
  const [weatherLocationName, setWeatherLocationName] = useState(settings.weatherLocationName ?? "");
  const [weatherLatitude, setWeatherLatitude] = useState(settings.weatherLatitude === null ? "" : String(settings.weatherLatitude));
  const [weatherLongitude, setWeatherLongitude] = useState(settings.weatherLongitude === null ? "" : String(settings.weatherLongitude));
  const [revision, setRevision] = useState(settings.revision);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const save = () => {
    setSuccess(false);
    if (weatherLatitude.trim() !== "" && Number.isNaN(Number(weatherLatitude))) {
      setError("緯度は数値で入力してください");
      return;
    }
    if (weatherLongitude.trim() !== "" && Number.isNaN(Number(weatherLongitude))) {
      setError("経度は数値で入力してください");
      return;
    }
    startTransition(async () => {
      const result = await updateDesignSettingsAction({
        houseName,
        headerCopy: headerCopy.trim() === "" ? null : headerCopy,
        footerCopy: footerCopy.trim() === "" ? null : footerCopy,
        footerQrUrl: footerQrUrl.trim() === "" ? null : footerQrUrl.trim(),
        logoMediaId,
        footerImageMediaId,
        weatherLocationName: weatherLocationName.trim() === "" ? null : weatherLocationName,
        weatherLatitude: weatherLatitude.trim() === "" ? null : Number(weatherLatitude),
        weatherLongitude: weatherLongitude.trim() === "" ? null : Number(weatherLongitude),
        categories: [],
        revision,
      });
      if (result.error) {
        setError(result.error.message);
        if (result.error.code === "conflict") router.refresh();
        return;
      }
      setError(null);
      setSuccess(true);
      setRevision(result.data.revision);
    });
  };

  return (
    <section className={styles.panel} aria-label="ハウス基本情報">
      <h2 className={styles.panelTitle}>ハウス基本情報</h2>
      <div className={styles.formGrid}>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="design-house-name">
            ハウス名
          </label>
          <input id="design-house-name" className={styles.input} value={houseName} maxLength={50} onChange={(e) => setHouseName(e.target.value)} />
        </div>
        <div />

        <div className={`${styles.field} ${styles.fieldFull}`}>
          <MediaUploadField
            label="ロゴ"
            hint="JPEG・PNG・WebP（20MBまで）"
            previewUrl={logoPreview}
            selectedId={logoMediaId}
            disabled={pending}
            onBusyChange={setUploading}
            onChange={(mediaId, preview) => {
              setLogoMediaId(mediaId);
              setLogoPreview(preview);
            }}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="design-header-copy">
            キャッチコピー（ヘッダー用）
          </label>
          <input
            id="design-header-copy"
            className={styles.input}
            value={headerCopy}
            maxLength={60}
            onChange={(e) => setHeaderCopy(e.target.value)}
          />
        </div>
        <div className={styles.field}>
          <label className={styles.label} htmlFor="design-footer-copy">
            キャッチコピー（フッター用）
          </label>
          <input
            id="design-footer-copy"
            className={styles.input}
            value={footerCopy}
            maxLength={60}
            onChange={(e) => setFooterCopy(e.target.value)}
          />
        </div>

        <div className={`${styles.field} ${styles.fieldFull}`}>
          <label className={styles.label} htmlFor="design-footer-qr-url">
            フッターの QR コード（飛び先の URL）
          </label>
          <input
            id="design-footer-qr-url"
            className={styles.input}
            type="url"
            value={footerQrUrl}
            maxLength={2000}
            placeholder="例：https://…（会議室予約のページ）"
            onChange={(e) => setFooterQrUrl(e.target.value)}
          />
          <p className={styles.hint}>
            フッターのキャッチコピーの横に QR コードで出します。空欄のあいだは、QR の場所に枠だけを出します。
          </p>
        </div>

        <div className={`${styles.field} ${styles.fieldFull}`}>
          <MediaUploadField
            label="フッター背景画像"
            hint="JPEG・PNG・WebP（20MBまで）"
            previewUrl={footerImagePreview}
            selectedId={footerImageMediaId}
            disabled={pending}
            onBusyChange={setUploading}
            onChange={(mediaId, preview) => {
              setFooterImageMediaId(mediaId);
              setFooterImagePreview(preview);
            }}
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="design-weather-name">
            天気を表示する地域（地名）
          </label>
          <input
            id="design-weather-name"
            className={styles.input}
            value={weatherLocationName}
            maxLength={50}
            placeholder="例：横浜市"
            onChange={(e) => setWeatherLocationName(e.target.value)}
          />
        </div>
        <div className={styles.field}>
          <span className={styles.label}>天気を表示する地域（緯度・経度）</span>
          <div style={{ display: "flex", gap: 10 }}>
            <input
              className={`${styles.input} ${styles.inputNumber}`}
              type="number"
              step="0.0001"
              min={-90}
              max={90}
              aria-label="緯度"
              placeholder="緯度"
              value={weatherLatitude}
              onChange={(e) => setWeatherLatitude(e.target.value)}
            />
            <input
              className={`${styles.input} ${styles.inputNumber}`}
              type="number"
              step="0.0001"
              min={-180}
              max={180}
              aria-label="経度"
              placeholder="経度"
              value={weatherLongitude}
              onChange={(e) => setWeatherLongitude(e.target.value)}
            />
          </div>
          <p className={styles.hint}>例：横浜駅は緯度 35.4658、経度 139.6222</p>
        </div>
      </div>

      <div className={styles.imageActions} style={{ marginTop: 20 }}>
        <button type="button" className={styles.primaryButton} disabled={pending || uploading || houseName.trim() === ""} onClick={save}>
          保存する
        </button>
      </div>
      {error ? (
        <p className={styles.formError} role="alert">
          {error}
        </p>
      ) : null}
      {success ? <p className={styles.formSuccess}>{SAVED_MESSAGE}</p> : null}
    </section>
  );
}

// ---------------------------------------------------------------- カテゴリ

function CategoriesSection({ categories }: { categories: EventCategoryRow[] }) {
  const [rows, setRows] = useState(() => categories.map((c) => ({ id: c.id, name: c.name, color: c.color })));
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [pending, startTransition] = useTransition();

  const setRow = (id: string, patch: Partial<{ name: string; color: string }>) => {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  };

  const save = () => {
    setSuccess(false);
    if (rows.some((r) => r.name.trim() === "")) {
      setError("カテゴリ名を入力してください");
      return;
    }
    startTransition(async () => {
      const result = await updateEventCategoriesAction({ categories: rows.map((r) => ({ id: r.id, name: r.name.trim(), color: r.color })) });
      if (result.error) {
        setError(result.error.message);
        return;
      }
      setError(null);
      setSuccess(true);
    });
  };

  return (
    <section className={styles.panel} aria-label="イベントカテゴリ">
      <h2 className={styles.panelTitle}>イベントカテゴリ</h2>
      <p className={styles.panelDesc}>カテゴリの追加・削除はできません。名前と色だけを変更できます。</p>
      {rows.length === 0 ? (
        <div className={styles.empty}>
          <p>カテゴリがありません。</p>
        </div>
      ) : (
        <div>
          {rows.map((r) => (
            <div key={r.id} className={styles.categoryRow}>
              <input
                type="color"
                className={styles.colorInput}
                aria-label={`${r.name} の色`}
                value={r.color}
                disabled={pending}
                onChange={(e) => setRow(r.id, { color: e.target.value })}
              />
              <input
                className={`${styles.input} ${styles.categoryName}`}
                aria-label="カテゴリ名"
                value={r.name}
                maxLength={20}
                disabled={pending}
                onChange={(e) => setRow(r.id, { name: e.target.value })}
              />
            </div>
          ))}
        </div>
      )}
      {rows.length > 0 ? (
        <div className={styles.imageActions} style={{ marginTop: 16 }}>
          <button type="button" className={styles.primaryButton} disabled={pending} onClick={save}>
            保存する
          </button>
        </div>
      ) : null}
      {error ? (
        <p className={styles.formError} role="alert">
          {error}
        </p>
      ) : null}
      {success ? <p className={styles.formSuccess}>{SAVED_MESSAGE}</p> : null}
    </section>
  );
}
