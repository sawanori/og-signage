"use client";

/** テスト表示。対象端末が次の同期で次の動画を 1 本すぐ再生する（1 回限り） */
import { useState, useTransition } from "react";
import { requestTestPlayAction } from "@/app/admin/_actions/playback";
import styles from "./admin.module.css";

export function TestPlayButton({ deviceId }: { deviceId: string }) {
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <>
      <button
        type="button"
        className={`${styles.outlineButton} ${styles.testButton}`}
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await requestTestPlayAction(deviceId);
            setMessage(
              result.ok
                ? { text: "次の同期で動画を 1 本再生します", error: false }
                : { text: result.error.message, error: true },
            );
          })
        }
      >
        テスト表示
      </button>
      {message ? (
        <p className={`${styles.cardError} ${message.error ? "" : styles.cardInfo}`} role="status">
          {message.text}
        </p>
      ) : null}
    </>
  );
}
