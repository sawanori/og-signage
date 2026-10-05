"use client";

/**
 * メンバー相談チャットの画面（/chat。2026-10-05 ユーザー指示。試験運用）。
 * 会話はこの画面の中だけで持ち、サーバーにもブラウザにも保存しない（読み込み直すと消える）。
 */
import "@fontsource/line-seed-jp/400.css";
import "@fontsource/line-seed-jp/700.css";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { COMPANY_CHAT_MAX_CHARS, COMPANY_CHAT_MAX_MESSAGES, type CompanyChatReply, type CompanyChatSuggestion } from "@/lib/company-chat";
import { countChars } from "@/lib/validators";
import styles from "./company-chat.module.css";

type ChatEntry = { role: "user"; text: string } | { role: "assistant"; text: string; suggestions: CompanyChatSuggestion[] };

const NETWORK_ERROR = "うまく送れませんでした。通信状況を確認して、もう一度お試しください。";
const EXAMPLES = ["採用向けの会社紹介動画を作りたい", "新しいサービスの会計まわりを相談したい", "自社のホームページを見直したい"];
const isWebUrl = (url: string | null): url is string => typeof url === "string" && /^https?:\/\//iu.test(url);

/** AI に渡す会話。提案した人の名前を添えて、続きの相談（「2人目について詳しく」など）が通じるようにする */
function toHistory(entries: ChatEntry[]) {
  const history = entries.map((entry) => ({
    role: entry.role,
    text: [...(entry.role === "assistant" && entry.suggestions.length
      ? `${entry.text}\n（提案した人: ${entry.suggestions.map((s) => `${s.companyName} ${s.personName}`).join("、")}）`
      : entry.text)].slice(0, COMPANY_CHAT_MAX_CHARS).join(""),
  })).slice(-COMPANY_CHAT_MAX_MESSAGES);
  // 古い分を落とした結果、AI の発言から始まるならそれも落とす
  return history[0]?.role === "assistant" ? history.slice(1) : history;
}

export function CompanyChat() {
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  useEffect(() => { bottom.current?.scrollIntoView?.({ block: "end" }); }, [entries, sending]);

  const tooLong = countChars(draft.trim()) > COMPANY_CHAT_MAX_CHARS;
  const canSend = !sending && draft.trim() !== "" && !tooLong;

  const send = async (text: string) => {
    const question = text.trim();
    if (!question || sending) return;
    const next: ChatEntry[] = [...entries, { role: "user", text: question }];
    setEntries(next);
    setDraft("");
    setError(null);
    setSending(true);
    let reply: CompanyChatReply | null = null;
    let message = NETWORK_ERROR;
    try {
      const response = await fetch("/api/chat", {
        method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin",
        body: JSON.stringify({ messages: toHistory(next) }), signal: AbortSignal.timeout(45_000),
      });
      const json: unknown = await response.json().catch(() => null);
      if (response.ok && json && typeof json === "object" && "data" in json) reply = (json as { data: CompanyChatReply }).data;
      else if (json && typeof json === "object" && "error" in json) {
        const detail = (json as { error?: { message?: unknown } }).error?.message;
        if (typeof detail === "string") message = detail;
      }
    } catch { /* 通信できなかった。下で知らせる */ }
    if (!alive.current) return;
    setSending(false);
    if (!reply) {
      // 送れなかった相談は入力欄に戻して、そのまま送り直せるようにする
      setEntries(entries);
      setDraft(question);
      setError(message);
      return;
    }
    setEntries([...next, { role: "assistant", text: reply.reply, suggestions: reply.suggestions }]);
  };

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (canSend) void send(draft);
  };

  return (
    <main className={styles.page}>
      <div className={styles.container}>
        <header className={styles.header}>
          <span className={styles.eyebrow}>MEMBER CONCIERGE</span>
          <h1>メンバー相談チャット<span className={styles.trial}>試験運用</span></h1>
          <p>仕事の困りごとを書くと、力になれそうな入居メンバーを提案します。</p>
        </header>

        <section className={styles.log} role="log" aria-live="polite" aria-label="相談の内容">
          {entries.length === 0 ? (
            <div className={styles.empty}>
              <p>たとえば、こんな相談ができます。</p>
              <div className={styles.examples}>
                {EXAMPLES.map((example) => (
                  <button key={example} type="button" className={styles.example} disabled={sending} onClick={() => void send(example)}>{example}</button>
                ))}
              </div>
            </div>
          ) : null}
          {entries.map((entry, index) => entry.role === "user" ? (
            <p key={index} className={styles.user}>{entry.text}</p>
          ) : (
            <div key={index} className={styles.assistant}>
              <p className={styles.reply}>{entry.text}</p>
              {entry.suggestions.map((suggestion) => <SuggestionCard key={suggestion.id} suggestion={suggestion} />)}
            </div>
          ))}
          {sending ? <p className={styles.thinking} role="status">メンバーを探しています…</p> : null}
          <div ref={bottom} />
        </section>

        <form className={styles.form} onSubmit={submit}>
          <label htmlFor="chat-draft" className={styles.label}>相談したいこと</label>
          <textarea id="chat-draft" rows={3} value={draft} disabled={sending} placeholder="例：採用向けの会社紹介動画を作りたい"
            aria-invalid={tooLong} aria-describedby="chat-count"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing && canSend) { event.preventDefault(); void send(draft); } }} />
          <div className={styles.formFoot}>
            <span id="chat-count" className={styles.count} data-over={tooLong ? "true" : undefined}>{countChars(draft.trim())} / {COMPANY_CHAT_MAX_CHARS}文字</span>
            <button type="submit" className={styles.send} disabled={!canSend}>{sending ? "送信中…" : "相談する"}</button>
          </div>
          {error ? <p role="alert" className={styles.error}>{error}</p> : null}
        </form>

        <p className={styles.note}>相談の内容は保存しません。この画面を閉じるか読み込み直すと、会話は消えます。提案は AI によるもので、各メンバーのサイネージの掲載内容とホームページの情報をもとにしています。</p>
      </div>
    </main>
  );
}

function SuggestionCard({ suggestion }: { suggestion: CompanyChatSuggestion }) {
  return (
    <article className={styles.card} aria-label={`${suggestion.personName} さんの提案`}>
      <div className={styles.cardHead}>
        <p className={styles.person}>{suggestion.personName}<span className={styles.san}>さん</span></p>
        {suggestion.floor !== null ? <span className={styles.floor}>{suggestion.floor}階</span> : null}
      </div>
      <p className={styles.company}>{suggestion.companyName}{suggestion.role ? `　${suggestion.role}` : ""}</p>
      <p className={styles.reason}>{suggestion.reason}</p>
      {suggestion.basis.length > 0 ? (
        <p className={styles.basis}>
          根拠：
          {suggestion.basis.map((item, index) => (
            <span key={index} className={styles.basisItem}>
              {isWebUrl(item.url) ? <a href={item.url} target="_blank" rel="noreferrer noopener">{item.label}</a> : item.label}
            </span>
          ))}
        </p>
      ) : null}
      {isWebUrl(suggestion.websiteUrl) ? (
        <a className={styles.site} href={suggestion.websiteUrl} target="_blank" rel="noreferrer noopener">ホームページを見る</a>
      ) : null}
    </article>
  );
}
