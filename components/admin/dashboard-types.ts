/**
 * 管理画面の枠とダッシュボードが受け取るデータ。
 *
 * /admin はサービス（lib/services/*）から、/dev/dashboard は固定データから同じ形を作る。
 * 部品はこの形だけを見て描くので、両者の違いはデータの取得部分だけになる。
 */
import type { Role } from "@/lib/auth";
import type { SignageEvent } from "@/lib/config-schema";
import type { DeviceStatus } from "@/lib/services/devices";

export const ROLE_LABELS: Record<Role, string> = {
  staff: "受付スタッフ",
  administrator: "管理者",
};

export type ShellUser = {
  name: string;
  role: Role;
  /** 顔写真。無ければ頭文字を出す */
  avatarUrl: string | null;
};

/** ベルに出す知らせ（端末の不調など） */
export type ShellAlert = { id: string; message: string };

export type ShellData = {
  user: ShellUser;
  alerts: ShellAlert[];
  /** サイドバー下のカードの写真。無ければ写真なしで描く */
  sidebarImageUrl: string | null;
};

/** 表示の業務規則（lib/display-rules.ts）をそのまま使えるよう SignageEvent に画像 URL を足した形 */
export type DashboardEvent = SignageEvent & { imageUrl: string | null };

export type DashboardVideo = {
  mediaId: string;
  name: string;
  durationSeconds: number | null;
  thumbnailUrl: string | null;
};

export type DashboardVideoSettings = {
  deviceId: string;
  revision: number;
  enabled: boolean;
  intervalMinutes: number;
  mode: "sequence" | "random";
  volume: number;
  videos: DashboardVideo[];
  /** Heartbeat が報告した次の動画の予定時刻と、その報告を受けた時刻（UNIX 秒） */
  nextVideoAt: number | null;
  observedAt: number | null;
};

export type DashboardNotice = {
  id: string;
  title: string;
  body: string | null;
  imageMediaId: string | null;
  enabled: boolean;
  displayMode: "always" | "timeRange";
  displayStartTime: string | null;
  displayEndTime: string | null;
  revision: number;
};

export type DashboardDevice = {
  id: string;
  name: string;
  status: DeviceStatus;
  lastSeenAt: number | null;
};

export type DashboardData = {
  /** 現在時刻（UNIX 秒） */
  now: number;
  events: DashboardEvent[];
  /** 端末が未登録なら null */
  video: DashboardVideoSettings | null;
  notice: DashboardNotice | null;
  device: DashboardDevice | null;
};
