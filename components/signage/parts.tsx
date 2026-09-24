/**
 * 縦型・横型で共用する小さな部品。
 */
import type { CSSProperties, ReactNode } from "react";
// QR の配置計算（中核）だけを読む。パッケージ入口（qrcode → lib/server.js）は PNG 書き出しのために
// 読み込み時に require("fs") を実行し、Cloudflare Workers のサーバー描画で落ちるため使わない。
import { create as createQrCode } from "qrcode/lib/core/qrcode";
import {
  BellOff,
  Bike,
  CigaretteOff,
  Cloud,
  CloudDrizzle,
  CloudFog,
  CloudLightning,
  CloudRain,
  CloudSnow,
  DoorClosed,
  Info,
  KeyRound,
  Lock,
  Moon,
  PhoneOff,
  Recycle,
  Smartphone,
  Sparkles,
  Sun,
  Trash2,
  Users,
  Utensils,
  VolumeX,
  Wifi,
  type LucideIcon,
} from "lucide-react";
import type { EventCategory, HouseRule, MediaRef } from "@/lib/config-schema";
import { httpUrlSchema } from "@/lib/validators";
import type { ResolveMediaUrl } from "./model";
import styles from "./signage.module.css";

/** ハウスルールのアイコン（config の icon は Lucide のアイコン名）。未知の名前は Info */
const RULE_ICONS: Record<string, LucideIcon> = {
  "bell-off": BellOff,
  bike: Bike,
  "cigarette-off": CigaretteOff,
  "door-closed": DoorClosed,
  info: Info,
  "key-round": KeyRound,
  lock: Lock,
  moon: Moon,
  "phone-off": PhoneOff,
  recycle: Recycle,
  smartphone: Smartphone,
  sparkles: Sparkles,
  "trash-2": Trash2,
  users: Users,
  utensils: Utensils,
  "volume-x": VolumeX,
  wifi: Wifi,
};

export function RuleIcon({ icon, size, strokeWidth }: { icon: HouseRule["icon"]; size: number; strokeWidth: number }) {
  const Icon = RULE_ICONS[icon] ?? Info;
  return <Icon size={size} strokeWidth={strokeWidth} aria-hidden />;
}

/** OpenWeatherMap の weather[0].main（小文字）ごとのアイコン。未知の値は Cloud */
const WEATHER_ICONS: Record<string, LucideIcon> = {
  clear: Sun,
  rain: CloudRain,
  drizzle: CloudDrizzle,
  thunderstorm: CloudLightning,
  snow: CloudSnow,
  mist: CloudFog,
  fog: CloudFog,
  haze: CloudFog,
  smoke: CloudFog,
  dust: CloudFog,
  sand: CloudFog,
  ash: CloudFog,
};

export function WeatherIcon({ condition, size, strokeWidth }: { condition: string; size: number; strokeWidth: number }) {
  const Icon = WEATHER_ICONS[condition] ?? Cloud;
  return <Icon size={size} strokeWidth={strokeWidth} aria-hidden />;
}

/** QR コード（http/https 以外の URL は出さない） */
export function QrCode({ url, size, className }: { url: string; size: number; className?: string }) {
  if (!httpUrlSchema.safeParse(url).success) return null;
  const qr = createQrCode(url, { errorCorrectionLevel: "M" });
  const n = qr.modules.size;
  let d = "";
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (qr.modules.get(x, y)) d += `M${x} ${y}h1v1h-1z`;
    }
  }
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox={`0 0 ${n} ${n}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label="イベント詳細の QR コード"
    >
      <path d={d} fill="#111820" />
    </svg>
  );
}

export function isQrUrl(url: string | null): url is string {
  return url !== null && httpUrlSchema.safeParse(url).success;
}

/**
 * 画像。画像がないときはカテゴリ色（カテゴリもなければ既定の色）の面を出す。
 */
export function MediaImage({
  media,
  category,
  resolveMediaUrl,
  className,
  style,
  children,
}: {
  media: MediaRef | null;
  category: EventCategory | null;
  resolveMediaUrl: ResolveMediaUrl;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  const fallback = category?.color ?? "#8A94A3";
  return (
    <div className={className} style={{ ...style, backgroundColor: fallback }} data-has-image={media ? "true" : "false"}>
      {media ? (
        // eslint-disable-next-line @next/next/no-img-element -- Pi はオフラインで静的配信するため next/image を使わない
        <img className={styles.cover} src={resolveMediaUrl(media)} alt="" draggable={false} />
      ) : null}
      {children}
    </div>
  );
}

/** 絵文字（カラー絵文字フォントで描く） */
export function Emoji({ children, className }: { children: string; className?: string }) {
  return (
    <span className={`${styles.emoji} ${className ?? ""}`} aria-hidden>
      {children}
    </span>
  );
}

/** 時刻が未同期であることを示す画面隅の小さな印 */
export function UnsyncedMark() {
  return (
    <div className={styles.unsynced} role="status" aria-label="時刻未同期">
      <span className={styles.unsyncedDot} />
    </div>
  );
}

/* 時間・場所・参加・主催の行のアイコン（塗りの図形は Lucide にないため SVG を直接持つ） */
type SvgIconProps = { size: number };

export function PinIcon({ size }: SvgIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path
        fill="currentColor"
        d="M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z"
      />
    </svg>
  );
}

export function GroupIcon({ size }: SvgIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path
        fill="currentColor"
        d="M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5s-3 1.34-3 3 1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z"
      />
    </svg>
  );
}

export function PersonOutlineIcon({ size }: SvgIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path
        fill="currentColor"
        d="M12 5.9a2.1 2.1 0 1 1 0 4.2 2.1 2.1 0 0 1 0-4.2m0 9c2.97 0 6.1 1.46 6.1 2.1v1.1H5.9V17c0-.64 3.13-2.1 6.1-2.1M12 4C9.79 4 8 5.79 8 8s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm0 9c-2.67 0-8 1.34-8 4v3h16v-3c0-2.66-5.33-4-8-4z"
      />
    </svg>
  );
}

export function PersonIcon({ size }: SvgIconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path fill="currentColor" d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" />
    </svg>
  );
}

/** 大きな欄のスライドショーの何枚目か（点の並び） */
export function HeroDots({ index, count, className }: { index: number; count: number; className: string }) {
  return (
    <div className={`${styles.heroDots} ${className}`} data-testid="hero-dots" aria-hidden>
      {Array.from({ length: count }, (_, i) => (
        <span key={i} data-active={i === index ? "true" : "false"} />
      ))}
    </div>
  );
}
