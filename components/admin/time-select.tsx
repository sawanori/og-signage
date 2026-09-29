"use client";

/**
 * 時刻を 15 分きざみで選ぶ（2026-09-29 ユーザー指示「イベント時間を 15 分で刻んで」）。
 * 時（00〜23）と分（00・15・30・45）の 2 つの選択。値は "HH:MM"、未入力は ""。
 * ブラウザの時刻の入力（type="time"）は 1 分単位で選べてしまうため置き換えた。
 * 15 分きざみでない時刻が保存済みなら、その分も選べる形で残す（開いただけで時刻が変わらないように）。
 */
import { useState } from "react";

const HOURS = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0"));
const MINUTES = ["00", "15", "30", "45"];

function split(value: string): { hour: string; minute: string } {
  const m = /^(\d{2}):(\d{2})$/.exec(value);
  return m ? { hour: m[1], minute: m[2] } : { hour: "", minute: "" };
}

export function TimeSelect({
  id,
  label,
  value,
  onChange,
  onBlur,
  className,
  wrapClassName,
  sepClassName,
  invalid = false,
}: {
  /** 時の選択の id（外の <label htmlFor> から指すとき） */
  id?: string;
  /** 読み上げ用の名前。「（時）」「（分）」を付けて使う */
  label: string;
  value: string;
  onChange: (value: string) => void;
  onBlur?: () => void;
  className: string;
  wrapClassName: string;
  sepClassName: string;
  invalid?: boolean;
}) {
  const current = split(value);
  // 時より先に分を選んだときは、時を選ぶまでここに覚えておく
  const [pendingMinute, setPendingMinute] = useState("");
  const hour = current.hour;
  const minute = hour !== "" ? current.minute : pendingMinute;
  const minutes = minute !== "" && !MINUTES.includes(minute) ? [...MINUTES, minute].sort() : MINUTES;

  const changeHour = (next: string) => {
    if (next === "") {
      setPendingMinute(minute);
      onChange("");
    } else {
      onChange(`${next}:${minute || "00"}`);
    }
  };
  const changeMinute = (next: string) => {
    if (hour === "") setPendingMinute(next);
    else onChange(`${hour}:${next || "00"}`);
  };

  const aria = invalid ? { "aria-invalid": true as const } : {};
  return (
    <div className={wrapClassName}>
      <select
        id={id}
        className={className}
        aria-label={`${label}（時）`}
        value={hour}
        onChange={(e) => changeHour(e.target.value)}
        onBlur={onBlur}
        {...aria}
      >
        <option value="">--</option>
        {HOURS.map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </select>
      <span className={sepClassName} aria-hidden>
        :
      </span>
      <select
        className={className}
        aria-label={`${label}（分）`}
        value={minute}
        onChange={(e) => changeMinute(e.target.value)}
        onBlur={onBlur}
        {...aria}
      >
        <option value="">--</option>
        {minutes.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
    </div>
  );
}
