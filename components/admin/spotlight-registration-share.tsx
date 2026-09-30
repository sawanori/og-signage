"use client";

import { Copy, Download, QrCode } from "lucide-react";
import QRCode from "qrcode";
import { useState } from "react";
import { SPOTLIGHT_REGISTRATION_PATH } from "@/lib/spotlight-submissions";
import styles from "./settings.module.css";

export function SpotlightRegistrationShare() {
  const [opened, setOpened] = useState(false);
  const [url, setUrl] = useState("");
  const [image, setImage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const open = async () => {
    if (opened) {
      setOpened(false);
      return;
    }
    const registrationUrl = new URL(SPOTLIGHT_REGISTRATION_PATH, window.location.origin).href;
    setUrl(registrationUrl);
    setOpened(true);
    setCopied(false);
    setError(null);
    setImage(null);
    try {
      setImage(await QRCode.toDataURL(registrationUrl, { type: "image/png", width: 640, margin: 4 }));
    } catch {
      setError("QRコードを作成できませんでした。いったん閉じて、もう一度開いてください。");
    }
  };

  const copy = async () => {
    setCopied(false);
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setError("URLをコピーできませんでした。下のURLを選択してコピーしてください。");
    }
  };

  return (
    <div>
      <button type="button" className={styles.secondaryButton} aria-expanded={opened} onClick={open}>
        <QrCode size={16} aria-hidden />
        登録用URL・QR
      </button>
      {opened ? (
        <section className={styles.panel} aria-label="登録用URL・QR" style={{ marginTop: 12 }}>
          <h2 className={styles.panelTitle}>メンバーに登録用URLを共有する</h2>
          <p className={styles.panelDesc}>QRコードをスマートフォンで読み取ると、メンバー紹介を入力できます。スタッフが掲載するまで公開されません。</p>
          <label className={styles.field} style={{ marginTop: 16 }}>
            <span className={styles.label}>登録用URL</span>
            <input className={styles.input} type="url" value={url} readOnly onFocus={(event) => event.currentTarget.select()} />
          </label>
          <div className={styles.rowActions} style={{ marginTop: 12 }}>
            <button type="button" className={styles.secondaryButton} onClick={copy}>
              <Copy size={14} aria-hidden />
              URLをコピー
            </button>
            {image ? (
              <a className={styles.secondaryButton} href={image} download="member-registration-qr.png">
                <Download size={14} aria-hidden />
                QRをPNGで保存
              </a>
            ) : null}
          </div>
          {copied ? <p className={styles.formSuccess} role="status">URLをコピーしました。</p> : null}
          {error ? <p className={styles.formError} role="alert">{error}</p> : null}
          {image ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={image} alt="メンバー紹介の登録用QRコード" width={240} height={240} style={{ marginTop: 16 }} />
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
