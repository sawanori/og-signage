"use client";

/**
 * メンバー情報（/admin/member-info、Administrator）。サイネージの「MEMBER INFO / メンバー情報」の欄に出す
 * 項目（見出しと文言、最大 3 件）を入力する。保存のたびに全件を置き換える（lib/services/house.ts の replaceHouseRules）。
 * 2026-09-25 ユーザー指示で、デザイン設定の中から専用の画面に移した（見つけやすくするため）。
 */
import { useState, useTransition } from "react";
import { updateHouseRulesAction } from "@/app/admin/_actions/content";
import type { HouseRuleRow } from "@/lib/services/house";
import { HOUSE_RULE_TEXT_MAX, HOUSE_RULE_TITLE_MAX, HOUSE_RULES_MAX } from "@/lib/validators";
import styles from "./settings.module.css";

const SAVED_MESSAGE = "保存しました。サイネージには 30 秒以内に反映されます。";

export function MemberInfoView({ rules }: { rules: HouseRuleRow[] }) {
  return (
    <div className={styles.page}>
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.pageTitle}>メンバー情報</h1>
          <p className={styles.pageDesc}>サイネージの「MEMBER INFO / メンバー情報」の欄に出す内容を入力します。</p>
        </div>
      </div>
      <MemberInfoSection rules={rules} />
    </div>
  );
}

/** メンバー情報の 1 項目。2026-09-25 からアイコンではなく見出し（任意）と文言 */
type RuleSlot = { title: string; text: string };

function toSlots(rules: HouseRuleRow[]): RuleSlot[] {
  return Array.from({ length: HOUSE_RULES_MAX }, (_, i) => ({ title: rules[i]?.title ?? "", text: rules[i]?.text ?? "" }));
}

function MemberInfoSection({ rules }: { rules: HouseRuleRow[] }) {
  const [slots, setSlots] = useState<RuleSlot[]>(() => toSlots(rules));
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [pending, startTransition] = useTransition();

  const setSlot = (index: number, patch: Partial<RuleSlot>) => {
    setSlots((prev) => prev.map((s, i) => (i === index ? { ...s, ...patch } : s)));
  };

  const save = () => {
    setSuccess(false);
    const filled = slots.filter((s) => s.text.trim() !== "");
    startTransition(async () => {
      const result = await updateHouseRulesAction({
        rules: filled.map((s) => ({ title: s.title.trim(), text: s.text.trim() })),
      });
      if (result.error) {
        setError(result.error.message);
        return;
      }
      setError(null);
      setSuccess(true);
    });
  };

  return (
    <section className={styles.panel} aria-label="メンバー情報">
      <h2 className={styles.panelTitle}>メンバー情報</h2>
      <p className={styles.panelDesc}>
        サイネージの「MEMBER INFO / メンバー情報」の欄に、見出し（任意・{HOUSE_RULE_TITLE_MAX}文字まで）と文言（
        {HOUSE_RULE_TEXT_MAX}文字まで。サイネージでは 3 行まで）を出します。最大 {HOUSE_RULES_MAX} 件まで。文言を空にした行は保存されません。
      </p>
      <div>
        {slots.map((slot, i) => (
          <div key={i} className={styles.ruleRow}>
            <span className={styles.ruleNum}>項目 {i + 1}</span>
            <div className={styles.ruleFields}>
              <input
                className={`${styles.input} ${styles.ruleTitleInput}`}
                aria-label={`項目 ${i + 1} の見出し`}
                value={slot.title}
                maxLength={HOUSE_RULE_TITLE_MAX}
                placeholder="見出し（例：受付）"
                disabled={pending}
                onChange={(e) => setSlot(i, { title: e.target.value })}
              />
              <input
                className={styles.input}
                aria-label={`項目 ${i + 1} の文言`}
                value={slot.text}
                maxLength={HOUSE_RULE_TEXT_MAX}
                placeholder="文言（例：お困りのことはスタッフまで）"
                disabled={pending}
                onChange={(e) => setSlot(i, { text: e.target.value })}
              />
            </div>
          </div>
        ))}
      </div>
      <div className={styles.imageActions} style={{ marginTop: 16 }}>
        <button type="button" className={styles.primaryButton} disabled={pending} onClick={save}>
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
