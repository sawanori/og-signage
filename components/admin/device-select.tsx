"use client";

/** 端末が複数あるときだけ出す端末の切り替え（?device=<id> で選ぶ） */
import { useRouter } from "next/navigation";
import admin from "./admin.module.css";
import type { DeviceOption } from "./media-types";
import styles from "./media.module.css";

export function DeviceSelect({ devices, current }: { devices: DeviceOption[]; current: string }) {
  const router = useRouter();
  return (
    <label className={styles.deviceSelect}>
      <span>端末</span>
      <select
        className={admin.select}
        value={current}
        onChange={(e) => router.push(`/admin/videos?device=${encodeURIComponent(e.target.value)}`)}
      >
        {devices.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
      </select>
    </label>
  );
}
