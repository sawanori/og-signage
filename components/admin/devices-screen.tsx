"use client";

/**
 * 端末画面（/admin/devices。Administrator のみ）。計画 8.2 節・9 節の Heartbeat 項目、要件定義書 24 節。
 *
 * 設定ファイル（config.json）は登録・トークン再発行の直後に Blob で 1 回だけダウンロードさせる。
 * 中身（トークンの平文を含む）は state にも DOM にも置かない。
 */
import { ExternalLink, Monitor, Plus, RefreshCw, Trash2, Volume2 } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState, useTransition, type CSSProperties, type FormEvent, type ReactNode } from "react";
import { deleteDeviceAction, registerDeviceAction, regenerateDeviceTokenAction } from "@/app/admin/_actions/devices";
import { requestTestPlayAction, updateDevicePlaybackSettingsAction } from "@/app/admin/_actions/playback";
import type { DeviceMediaFailure, DeviceStatus } from "@/lib/services/devices";
import styles from "./admin.module.css";
import { ConfirmDialog, type ConfirmRequest } from "./confirm-dialog";
import d from "./devices.module.css";
import type { DeviceView } from "./devices-types";
import { formatHm, formatMonthDay } from "./format";

type Notice = { text: string; error: boolean } | null;

/** lib/services/devices.ts の DEVICE_STATUS_LABELS と同じ文言（サーバー用モジュールをクライアントに持ち込まない） */
const STATUS_LABELS: Record<DeviceStatus, string> = { online: "ONLINE", offline: "OFFLINE", display_error: "表示異常" };

const ORIENTATION_LABELS = { portrait: "縦", landscape: "横" } as const;

const FAILURE_REASON_LABELS: Record<DeviceMediaFailure["reason"], string> = {
  download_failed: "取得に失敗",
  hash_mismatch: "内容が一致しない",
  playback_failed: "再生に失敗",
};

/** 設定ファイルを保存させる。中身は URL.createObjectURL の Blob だけに渡し、画面には出さない */
function downloadOnce(content: string, fileName: string) {
  const url = URL.createObjectURL(new Blob([content], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const DOWNLOADED =
  "設定ファイル（config.json）をダウンロードしました。この画面で再び取り出すことはできません。見当たらない場合は設定ファイルを再発行してください。";

function formatDateTime(unix: number | null): string {
  return unix === null ? "—" : `${formatMonthDay(unix)} ${formatHm(unix)}`;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return "—";
  const gb = bytes / 1024 ** 3;
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

function shortVersion(value: string | null): string {
  return value === null ? "—" : value.length > 12 ? value.slice(0, 12) : value;
}

export function DevicesScreen({ devices }: { devices: DeviceView[] }) {
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  return (
    <div className={d.page}>
      <div className={d.pageHead}>
        <h2 className={d.pageTitle}>サイネージ端末</h2>
        <p className={d.pageSub}>表示端末の状態を確かめ、登録・設定ファイルの発行・音量の変更ができます。</p>
      </div>
      <div className={d.topRow}>
        <RegisterCard />
        <GuideCard />
      </div>
      {devices.length === 0 ? (
        <section className={`${styles.card} ${d.emptyCard}`}>
          <Monitor className={d.emptyIcon} aria-hidden />
          <p>まだ端末が登録されていません。上のフォームから登録してください。</p>
        </section>
      ) : (
        devices.map((device) => <DeviceCard key={device.id} device={device} onConfirm={setConfirm} />)
      )}
      {confirm ? <ConfirmDialog request={confirm} onClose={() => setConfirm(null)} /> : null}
    </div>
  );
}

// ---------------------------------------------------------------- 登録

function RegisterCard() {
  const [notice, setNotice] = useState<Notice>(null);
  const [pending, startTransition] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);
  const router = useRouter();

  const onSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    startTransition(async () => {
      const result = await registerDeviceAction(data);
      if (!result.ok) {
        setNotice({ text: result.error, error: true });
        return;
      }
      downloadOnce(result.data.content, result.data.fileName);
      setNotice({ text: `端末を登録しました。${DOWNLOADED}`, error: false });
      formRef.current?.reset();
      router.refresh();
    });
  };

  return (
    <section className={`${styles.card} ${d.registerCard}`} aria-labelledby="register-title">
      <h3 id="register-title" className={styles.cardTitle}>
        端末を登録
      </h3>
      <form ref={formRef} className={d.registerForm} onSubmit={onSubmit}>
        <label className={d.field}>
          <span className={d.label}>名前</span>
          <input className={d.input} name="name" required maxLength={100} placeholder="例: エントランス（1F）" />
        </label>
        <label className={d.field}>
          <span className={d.label}>向き</span>
          <select className={`${styles.select} ${d.selectField}`} name="orientation" defaultValue="portrait">
            <option value="portrait">縦</option>
            <option value="landscape">横</option>
          </select>
        </label>
        <div className={d.field}>
          <span className={d.label}>解像度</span>
          <span className={d.resolution}>
            <input
              className={`${d.input} ${d.numberInput}`}
              name="resolutionWidth"
              type="number"
              min={320}
              max={7680}
              defaultValue={1080}
              aria-label="横の画素数"
              required
            />
            <span aria-hidden>×</span>
            <input
              className={`${d.input} ${d.numberInput}`}
              name="resolutionHeight"
              type="number"
              min={320}
              max={7680}
              defaultValue={1920}
              aria-label="縦の画素数"
              required
            />
          </span>
        </div>
        <button type="submit" className={d.primaryButton} disabled={pending}>
          <Plus size={18} strokeWidth={2.4} aria-hidden />
          登録して設定ファイルを取得
        </button>
      </form>
      {notice ? <Message notice={notice} /> : null}
    </section>
  );
}

function GuideCard() {
  return (
    <section className={`${styles.card} ${d.guideCard}`} aria-labelledby="guide-title">
      <h3 id="guide-title" className={styles.cardTitle}>
        導入の流れ
      </h3>
      <ol className={d.guideList}>
        <li>端末を登録すると、設定ファイル（config.json）が 1 回だけダウンロードされます。</li>
        <li>Raspberry Pi OS（Bookworm 64bit）を入れた Pi に、導入用フォルダ・config.json・表示データの zip をコピーします。</li>
        <li>Pi で導入スクリプト（install.sh）を実行して再起動すると、自動で表示が始まります。</li>
        <li>導入が済んだら、Pi と PC に残った config.json は削除してください。詳しくは raspberry-pi/README.md を見てください。</li>
      </ol>
    </section>
  );
}

// ---------------------------------------------------------------- 端末

function DeviceCard({ device, onConfirm }: { device: DeviceView; onConfirm: (r: ConfirmRequest) => void }) {
  const [notice, setNotice] = useState<Notice>(null);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  const run = (task: () => Promise<void>) => startTransition(task);

  const reissue = () =>
    onConfirm({
      title: "設定ファイルを再発行しますか？",
      body: "今の設定ファイルは使えなくなり、Pi は新しい設定ファイルを置き直すまで表示を更新できません。新しい設定ファイルは 1 回だけダウンロードされます。",
      confirmLabel: "再発行する",
      onConfirm: () =>
        run(async () => {
          const result = await regenerateDeviceTokenAction(device.id);
          if (!result.ok) return setNotice({ text: result.error, error: true });
          downloadOnce(result.data.content, result.data.fileName);
          setNotice({ text: `再発行しました。${DOWNLOADED}`, error: false });
        }),
    });

  const remove = () =>
    onConfirm({
      title: `「${device.name}」を削除しますか？`,
      body: "端末のログと動画設定も消え、元に戻せません。この端末は表示を更新できなくなります。",
      confirmLabel: "削除する",
      danger: true,
      onConfirm: () =>
        run(async () => {
          const result = await deleteDeviceAction(device.id);
          if (!result.ok) return setNotice({ text: result.error, error: true });
          router.refresh();
        }),
    });

  const testPlay = () =>
    run(async () => {
      const result = await requestTestPlayAction(device.id);
      setNotice(
        result.ok
          ? { text: "次の同期で動画を 1 本再生します", error: false }
          : { text: result.error.message, error: true },
      );
    });

  return (
    <section className={`${styles.card} ${d.deviceCard}`} aria-label={device.name}>
      <div className={d.deviceHead}>
        <span className={styles.statusDot} data-status={device.status} aria-hidden />
        <span className={d.statusText} data-status={device.status}>
          {STATUS_LABELS[device.status]}
        </span>
        <span className={styles.deviceSep} aria-hidden />
        <h3 className={d.deviceName}>{device.name}</h3>
        <div className={d.deviceActions}>
          <Link href={`/admin/devices/${device.id}/preview`} className={`${styles.outlineButton} ${d.actionButton}`}>
            <ExternalLink size={15} aria-hidden />
            プレビュー
          </Link>
          <button type="button" className={`${styles.outlineButton} ${d.actionButton}`} disabled={pending} onClick={testPlay}>
            テスト表示
          </button>
          <button type="button" className={`${styles.outlineButton} ${d.actionButton}`} disabled={pending} onClick={reissue}>
            <RefreshCw size={15} aria-hidden />
            設定ファイル再発行
          </button>
          <button
            type="button"
            className={`${styles.outlineButton} ${d.actionButton} ${d.dangerButton}`}
            disabled={pending}
            onClick={remove}
          >
            <Trash2 size={15} aria-hidden />
            削除
          </button>
        </div>
      </div>

      <dl className={d.stats}>
        <Stat label="最終通信">{formatDateTime(device.lastSeenAt)}</Stat>
        <Stat label="向き">{ORIENTATION_LABELS[device.orientation]}</Stat>
        <Stat label="解像度">
          {device.resolutionWidth} x {device.resolutionHeight}
        </Stat>
        <Stat label="時刻同期">
          {device.timeSynced === null ? "—" : device.timeSynced ? "同期済み" : <span className={d.warn}>未同期</span>}
        </Stat>
        <Stat label="空き容量">{formatBytes(device.diskFreeBytes)}</Stat>
        <Stat label="CPU 温度">{device.cpuTempC === null ? "—" : `${device.cpuTempC.toFixed(1)}℃`}</Stat>
        <Stat label="Agent の版" title={device.agentVersion ?? undefined}>
          {shortVersion(device.agentVersion)}
        </Stat>
        <Stat label="表示バンドルの版" title={device.bundleId ?? undefined}>
          {shortVersion(device.bundleId)}
        </Stat>
        <Stat label="適用中の設定の版" title={device.appliedVersion ?? undefined}>
          {shortVersion(device.appliedVersion)}
        </Stat>
      </dl>
      {device.lastSeenAt === null ? (
        <p className={d.note}>まだ端末から通信がありません。Pi に設定ファイルを置いて起動すると、ここに状態が出ます。</p>
      ) : null}

      <VolumeRow device={device} onNotice={setNotice} />

      <div className={d.columns}>
        <div>
          <h4 className={d.subTitle}>直近のログ（10 件）</h4>
          {device.logs.length === 0 ? (
            <p className={d.none}>ログはまだありません</p>
          ) : (
            <ul className={d.logList}>
              {device.logs.map((log) => (
                <li key={log.id} className={d.logItem}>
                  <span className={d.logTime}>{formatDateTime(log.createdAt)}</span>
                  <span className={d.logType}>{log.type}</span>
                  <span className={d.logMessage} title={log.message ?? undefined}>
                    {log.message ?? ""}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h4 className={d.subTitle}>再生に失敗した媒体</h4>
          {device.failures.length === 0 ? (
            <p className={d.none}>失敗の報告はありません</p>
          ) : (
            <ul className={d.logList}>
              {device.failures.map((f) => (
                <li key={f.id} className={d.failureItem}>
                  <span className={d.failureName}>{f.mediaName ?? (f.bundleId ? "表示バンドル" : "削除済みの媒体")}</span>
                  <span className={d.failureReason}>
                    {FAILURE_REASON_LABELS[f.reason]}
                    {f.quarantined ? "・隔離中" : ""}
                  </span>
                  <span className={d.logTime}>
                    {f.count} 回・最後 {formatDateTime(f.lastAt)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
      {notice ? <Message notice={notice} /> : null}
    </section>
  );
}

function Stat({ label, title, children }: { label: string; title?: string; children: ReactNode }) {
  return (
    <div className={d.stat}>
      <dt className={d.statLabel}>{label}</dt>
      <dd className={d.statValue} title={title}>
        {children}
      </dd>
    </div>
  );
}

function VolumeRow({ device, onNotice }: { device: DeviceView; onNotice: (n: Notice) => void }) {
  const [playback, setPlayback] = useState(device.playback);
  const [volume, setVolume] = useState(device.playback?.volume ?? 0);
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  if (!playback) {
    return <p className={d.note}>この端末の動画設定が見つからないため、音量を変えられません。</p>;
  }

  const save = () =>
    startTransition(async () => {
      const result = await updateDevicePlaybackSettingsAction(device.id, {
        revision: playback.revision,
        enabled: playback.enabled,
        intervalMinutes: playback.intervalMinutes,
        mode: playback.mode,
        volume,
      });
      if (result.ok) {
        setPlayback({ ...playback, revision: result.data.revision, volume: result.data.volume });
        onNotice({ text: `音量を ${result.data.volume} にしました。次の同期で端末に反映されます`, error: false });
      } else {
        onNotice({ text: result.error.message, error: true });
        if (result.error.code === "conflict") router.refresh();
      }
    });

  return (
    <div className={d.volumeRow}>
      <Volume2 className={d.volumeIcon} aria-hidden />
      <label className={d.volumeLabel} htmlFor={`volume-${device.id}`}>
        動画の音量
      </label>
      <input
        id={`volume-${device.id}`}
        className={d.range}
        type="range"
        min={0}
        max={100}
        step={5}
        value={volume}
        onChange={(e) => setVolume(Number(e.target.value))}
        style={{ "--fill": `${volume}%` } as CSSProperties}
      />
      <span className={d.volumeValue}>{volume === 0 ? "ミュート" : volume}</span>
      <button
        type="button"
        className={`${styles.outlineButton} ${d.actionButton}`}
        disabled={pending || volume === playback.volume}
        onClick={save}
      >
        保存
      </button>
    </div>
  );
}

function Message({ notice }: { notice: NonNullable<Notice> }) {
  return (
    <p className={`${d.message} ${notice.error ? d.messageError : ""}`} role="status">
      {notice.text}
    </p>
  );
}
