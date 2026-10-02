/**
 * 企業データ（/admin/company-research。2026-10-02 ユーザー指示）。メンバーのホームページから集めた企業情報を、
 * 閲覧を許可したアカウントだけが確認する。読むだけの画面で、ここからは何も変えない。
 */
import type { CompanyClaim, CompanyResearchEntry } from "@/lib/services/company-research-view";
import styles from "./settings.module.css";
import view from "./company-research.module.css";

const STATUS: Record<CompanyResearchEntry["status"], string> = { done: "完了", working: "処理中", failed: "失敗", waiting: "待機中" };
const KIND: Record<string, string> = { fact: "事実", site_claim: "サイトの説明", inference: "推定" };
const ERRORS: Record<string, string> = {
  no_eligible_pages: "取得したページから、AI に送れる企業情報が見つかりませんでした",
  private_model_output: "AI の結果に個人情報らしき内容があったため保存しませんでした",
  job_budget_exhausted: "1 社あたりの AI 費用の上限に達しました",
  budget_exhausted: "今月の費用の上限に達しました（翌月に再開します）",
  configuration_required: "巡回または AI の設定の確認が必要です",
  interrupted_attempt_limit: "処理が何度も中断されたため止めました",
};
const REASONS: Record<string, string> = {
  personal_content_removed: "個人情報らしき行を除きました",
  ambiguous_personal_content_removed: "人名らしき行を除きました",
  unsupported_format: "PDF など読めない資料がありました",
  outside_registered_host: "登録したサイトの外へのリンクは読みませんでした",
  page_limit: "ページ数の上限に達しました",
  crawl_site_disallowed: "サイトが AI による巡回を断っています",
  unsafe_url: "存在しないか公開されていない URL がありました",
  input_budget_limit: "AI に送れる量の上限を超えた分は読みませんでした",
  crawl_time_limit: "巡回が時間の上限に達しました",
};
const dateTime = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "medium", timeStyle: "short" });
const formatSeconds = (seconds: number) => dateTime.format(new Date(seconds * 1000));

function ClaimList({ title, items, sources }: { title: string; items: CompanyClaim[]; sources: Map<string, string> }) {
  if (items.length === 0) return null;
  return (
    <div className={view.block}>
      <h3 className={view.blockTitle}>{title}</h3>
      <ul className={view.claims}>
        {items.map((item, index) => <ClaimItem key={index} item={item} sources={sources} />)}
      </ul>
    </div>
  );
}

function ClaimItem({ item, sources }: { item: CompanyClaim; sources: Map<string, string> }) {
  return (
    <li>
      <span title={item.evidenceText ? `根拠の引用: ${item.evidenceText}` : undefined}>{item.text}</span>
      <span className={view.kind}>{KIND[item.kind] ?? item.kind}</span>
      {item.sourceIds.map((id, index) => {
        const url = sources.get(id);
        return url ? (
          <a key={id} className={view.source} href={url} target="_blank" rel="noreferrer noopener">
            根拠{item.sourceIds.length > 1 ? index + 1 : ""}
          </a>
        ) : null;
      })}
    </li>
  );
}

function Profile({ entry }: { entry: CompanyResearchEntry }) {
  const profile = entry.profile;
  if (!profile) return <p className={styles.hint}>まだ企業データはありません。</p>;
  const sources = new Map(profile.sources.map((source) => [source.sourceId, source.url]));
  const company = profile.company;
  return (
    <>
      {company.summary ? <p className={view.summary}>{company.summary.text}</p> : null}
      <ClaimList title="業種" items={company.industries} sources={sources} />
      <ClaimList title="対応地域" items={company.regions} sources={sources} />
      {profile.services.length > 0 ? (
        <div className={view.block}>
          <h3 className={view.blockTitle}>サービス</h3>
          {profile.services.map((service, index) => (
            <div key={index} className={view.service}>
              <p className={view.serviceName}>{service.name.text}</p>
              {service.description ? <p className={view.serviceText}>{service.description.text}</p> : null}
              <ClaimList title="対象顧客" items={service.targetCustomers} sources={sources} />
              <ClaimList title="解決する課題" items={service.problemsSolved} sources={sources} />
              <ClaimList title="提供方法" items={service.delivery} sources={sources} />
              <ClaimList title="料金" items={service.pricing} sources={sources} />
            </div>
          ))}
        </div>
      ) : null}
      <ClaimList title="強み" items={profile.strengths} sources={sources} />
      <ClaimList title="制約・注意点" items={profile.limitations} sources={sources} />
      <ClaimList title="情報源どうしの食い違い" items={profile.sourceConflicts} sources={sources} />
      {profile.unknowns.length > 0 ? (
        <div className={view.block}>
          <h3 className={view.blockTitle}>サイトから分からなかったこと</h3>
          <ul className={view.claims}>{profile.unknowns.map((text, index) => <li key={index}>{text}</li>)}</ul>
        </div>
      ) : null}
      <div className={view.block}>
        <h3 className={view.blockTitle}>取得の状況</h3>
        <p className={styles.hint}>
          {profile.coverage ? `取得 ${profile.coverage.fetched} ページのうち ${profile.coverage.processed} ページを AI に送りました（${profile.coverage.status === "complete" ? "対象範囲はすべて取得" : "一部"}）。` : ""}
          AI でまとめた日時: {formatSeconds(profile.extractedAt)}
        </p>
        {profile.coverage && profile.coverage.reasons.length > 0 ? (
          <ul className={view.reasons}>
            {profile.coverage.reasons.map((reason) => <li key={reason}>{REASONS[reason] ?? reason}</li>)}
          </ul>
        ) : null}
      </div>
    </>
  );
}

export function CompanyResearchView({ entries }: { entries: CompanyResearchEntry[] | null }) {
  return (
    <div className={styles.page}>
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.pageTitle}>企業データ</h1>
          <p className={styles.pageDesc}>
            メンバーが登録したホームページから、AI が集めた企業情報です。サイネージや公開ページには出しません。項目の右の「根拠」から元のページを開けます。
          </p>
        </div>
      </div>
      {entries === null ? (
        <section className={styles.panel}>
          <p role="alert" className={styles.hint}>企業データを読み込めませんでした。時間をおいて開き直してください。</p>
        </section>
      ) : entries.length === 0 ? (
        <section className={styles.panel}>
          <p className={styles.hint}>ホームページの URL を登録したメンバーはまだいません。</p>
        </section>
      ) : (
        <section className={styles.panel} aria-label="企業データの一覧">
          <p className={styles.hint}>{entries.length} 件</p>
          {entries.map((entry) => (
            <details key={entry.sourceId} className={view.entry}>
              <summary className={view.entrySummary}>
                <span className={view.entryName}>
                  {entry.profile?.company.name?.text ?? entry.member?.companyName ?? "（削除されたメンバー）"}
                  {entry.member ? <span className={view.person}>{entry.member.personName} さん</span> : null}
                </span>
                <span className={`${view.status} ${view[entry.status]}`}>{STATUS[entry.status]}</span>
              </summary>
              <div className={view.entryBody}>
                {entry.urls.length > 0 ? (
                  <p className={styles.hint}>
                    登録 URL:{" "}
                    {entry.urls.map((url) => (
                      <a key={url} className={view.source} href={url} target="_blank" rel="noreferrer noopener">{url}</a>
                    ))}
                  </p>
                ) : null}
                {entry.status === "failed" && entry.errorCode ? <p className={view.error}>{ERRORS[entry.errorCode] ?? `処理に失敗しました（${entry.errorCode}）`}</p> : null}
                {entry.status === "working" ? <p className={styles.hint}>巡回または AI での整理を進めています。数分から数十分で更新されます。</p> : null}
                <Profile entry={entry} />
              </div>
            </details>
          ))}
        </section>
      )}
    </div>
  );
}
