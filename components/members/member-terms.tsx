/**
 * メンバー紹介の登録規約（個人情報の取扱いを含む。2026-10-03 ユーザー指示）。
 * NonTurn合同会社と登録者の間の約束で、WeWork を運営する WWJ株式会社 は当事者ではないことを明記する。
 * 内容を変えたら SPOTLIGHT_SUBMISSION_CONSENT_VERSION（lib/spotlight-submissions.ts）と制定・改定日を上げる。
 */
import "@fontsource/line-seed-jp/400.css";
import "@fontsource/line-seed-jp/700.css";
import { MEMBER_TERMS_CONTACT_EMAIL, MEMBER_TERMS_EFFECTIVE_DATE } from "@/lib/member-terms";
import styles from "./registration.module.css";
import terms from "./member-terms.module.css";

export function MemberTerms() {
  return (
    <main className={styles.page}>
      <div className={styles.container}>
        <header className={styles.header}>
          <span className={styles.eyebrow}>MEMBER SPOTLIGHT</span>
          <h1>メンバー紹介 登録規約</h1>
          <p className={styles.hint}>個人情報の取扱いを含みます。制定日：{MEMBER_TERMS_EFFECTIVE_DATE}</p>
        </header>
        <article className={`${styles.card} ${terms.terms}`}>
          <section>
            <h2>第1条（この規約について）</h2>
            <p>この規約は、NonTurn合同会社（以下「当社」）が運用するデジタルサイネージの「メンバー紹介」に、ご自身の情報を登録する方（以下「登録者」）と当社との間で適用されます。登録者は、登録フォームで同意することにより、この規約に同意したものとします。</p>
          </section>
          <section>
            <h2>第2条（WeWork を運営する会社との関係）</h2>
            <ol>
              <li>本サイネージは、当社が独自に運用するものです。</li>
              <li>登録された情報の取得・利用・管理・削除は、当社と登録者の間の事項です。WeWork を運営する WWJ株式会社 は、この規約の当事者ではありません。</li>
              <li>WWJ株式会社 は、登録された情報の取扱いに関与せず、これについて責任を負いません。</li>
              <li>登録情報に関するお問い合わせ・ご請求は、当社へお寄せください。</li>
            </ol>
          </section>
          <section>
            <h2>第3条（取得する情報）</h2>
            <p>当社は、登録フォームで次の情報を取得します。</p>
            <ol>
              <li>会社名・所属、お名前、ふりがな、肩書き、ひとこと、紹介文、タグ、写真、ホームページの URL</li>
              <li>メールアドレス</li>
              <li>名刺の画像（「名刺から入力」を使った場合のみ）</li>
            </ol>
          </section>
          <section>
            <h2>第4条（利用目的）</h2>
            <p>当社は、取得した情報を次の目的で利用します。</p>
            <ol>
              <li>館内のサイネージと、ログイン不要の Web サイネージへの掲載</li>
              <li>掲載の可否などのご連絡（メールアドレスを使います）</li>
              <li>名刺の画像からの入力補助</li>
              <li>登録されたホームページの公開情報を当社が収集・整理し、企業情報として蓄積すること。蓄積した情報は、本サイネージの運用に関連するサービスと、その派生サービスの検討・提供に使います。</li>
              <li>お問い合わせへの対応、本サイネージの運用・管理</li>
            </ol>
          </section>
          <section>
            <h2>第5条（公開の範囲）</h2>
            <ol>
              <li>第3条1号の情報（写真を含む）は、館内のサイネージと、URL を知っていれば誰でも閲覧できる Web サイネージに表示されます。</li>
              <li>メールアドレス、名刺の画像、第4条4号の企業情報は公開しません。</li>
            </ol>
          </section>
          <section>
            <h2>第6条（名刺の画像）</h2>
            <p>名刺の画像は、文字の読み取りにだけ使い、保存しません。</p>
          </section>
          <section>
            <h2>第7条（外部サービスの利用）</h2>
            <ol>
              <li>当社は、次の外部サービスに情報の取扱いを任せています。サーバーとデータの保存：Cloudflare、Turso／メールの送信：Resend／名刺の読み取り：Google（Gemini）／ホームページの公開情報の整理：Meta</li>
              <li>Google には、送った内容をサービスの改善に使わない契約で利用しています。</li>
              <li>Meta には、ホームページの公開情報から個人に関する部分を除いたものだけを送ります。Meta の規約上、送った内容が同社の AI の改善に使われることがあります。</li>
              <li>これらのサービスでは、情報が日本国外（米国など）のサーバーで扱われることがあります。</li>
            </ol>
          </section>
          <section>
            <h2>第8条（第三者への提供）</h2>
            <p>当社は、第5条の公開と第7条の委託の場合、および法令に基づく場合を除き、登録者の同意なく個人情報を第三者に提供しません。</p>
          </section>
          <section>
            <h2>第9条（保存期間と削除）</h2>
            <ol>
              <li>掲載中の情報は、掲載を続けるために保存します。</li>
              <li>掲載しなかった申請の情報は、一定期間が過ぎたら削除します。</li>
              <li>掲載の終了や削除のご依頼を受けたときは、速やかに削除します。</li>
              <li>第4条4号の企業情報は、ホームページの URL の削除や掲載の終了から7日以内に削除します。</li>
            </ol>
          </section>
          <section>
            <h2>第10条（開示・訂正・削除などのご請求）</h2>
            <p>登録者は、ご自身の情報の開示・訂正・削除・利用停止を、当社に請求できます。末尾の窓口までご連絡ください。</p>
          </section>
          <section>
            <h2>第11条（登録者のお約束）</h2>
            <ol>
              <li>登録者は、ご自身の情報と、権利を持つ写真・情報だけを登録してください。</li>
              <li>他の人の個人情報を、その人の同意なく登録しないでください。</li>
            </ol>
          </section>
          <section>
            <h2>第12条（掲載の判断）</h2>
            <ol>
              <li>当社は、登録内容を確認したうえで掲載します。</li>
              <li>内容によっては、掲載しないこと、または掲載後に取り下げることがあります。</li>
            </ol>
          </section>
          <section>
            <h2>第13条（規約の変更）</h2>
            <ol>
              <li>当社は、この規約を変更することがあります。</li>
              <li>変更後の規約は、このページに掲載した時点から適用します。</li>
            </ol>
          </section>
          <section>
            <h2>第14条（準拠法と管轄）</h2>
            <ol>
              <li>この規約は、日本法に従います。</li>
              <li>紛争が生じた場合は、横浜地方裁判所を第一審の専属的合意管轄裁判所とします。</li>
            </ol>
          </section>
          <section className={terms.contact}>
            <h2>お問い合わせ窓口</h2>
            <p>
              NonTurn合同会社
              <br />
              メール：<a href={`mailto:${MEMBER_TERMS_CONTACT_EMAIL}`}>{MEMBER_TERMS_CONTACT_EMAIL}</a>
              <br />
              当社の所在地と代表者の氏名は、お問い合わせいただければ遅滞なくお知らせします。
            </p>
          </section>
        </article>
      </div>
    </main>
  );
}
