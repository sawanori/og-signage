/** 端末画面・システム設定画面の部品に渡すデータの形（サーバーで組み立て、クライアント部品へ渡す） */
import type { Role } from "@/lib/auth";
import type { DeviceLogEntry, DeviceMediaFailure, DeviceStatus } from "@/lib/services/devices";

export type DevicePlaybackView = {
  revision: number;
  enabled: boolean;
  intervalMinutes: number;
  mode: "sequence" | "random";
  volume: number;
};

export type DeviceView = {
  id: string;
  name: string;
  status: DeviceStatus;
  lastSeenAt: number | null;
  orientation: "portrait" | "landscape";
  resolutionWidth: number;
  resolutionHeight: number;
  agentVersion: string | null;
  bundleId: string | null;
  appliedVersion: string | null;
  diskFreeBytes: number | null;
  cpuTempC: number | null;
  timeSynced: boolean | null;
  logs: DeviceLogEntry[];
  failures: DeviceMediaFailure[];
  /** 動画設定が無い端末は null（音量を変えられない） */
  playback: DevicePlaybackView | null;
};

export type UserView = {
  id: string;
  email: string;
  name: string | null;
  role: Role;
  isActive: boolean;
};
