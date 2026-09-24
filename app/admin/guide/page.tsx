/**
 * 利用ガイド（/admin/guide、Staff 以上）。受付スタッフ向けの操作説明。静的ページ（技術用語なし）。
 */
import styles from "@/components/admin/settings.module.css";
import { requirePageUser } from "../_components/current-user";

export const dynamic = "force-dynamic";

export const metadata = { title: "利用ガイド | サイネージ管理" };

type Step = { title: string; steps: string[] };

const SECTIONS: Step[] = [
  {
    title: "イベントを追加する",
    steps: [
      "「ダッシュボード」または「イベント管理」の「新しいイベントを作成」ボタンを押します。",
      "イベント名・日時・場所・写真などを入力します。",
      "内容を確認して「公開する」を押すと、サイネージにすぐ表示されます。まだ表示したくないときは「下書き」のまま保存できます。",
    ],
  },
  {
    title: "動画を変更する",
    steps: [
      "左のメニューの「動画・メディア」を開きます。",
      "「動画を追加」から新しい動画ファイルを選び、アップロードします。",
      "再生する順番を入れ替えたいときは、並び順を変えて「保存する」を押します。",
    ],
  },
  {
    title: "お知らせを出す",
    steps: [
      "左のメニューの「お知らせ」を開きます。",
      "見出しと内容を入力し、必要であれば画像を選びます。",
      "表示をONにして「保存する」を押すと、イベントがない時間にサイネージへ表示されます。",
    ],
  },
  {
    title: "困ったときは",
    steps: [
      "保存した内容がサイネージに表示されるまで、30秒ほどかかることがあります。少し待ってからもう一度確認してください。",
      "画面の右上にあるベルのアイコンに赤い印がついているときは、押すと詳しい状況を確認できます。",
      "サイネージの画面が真っ暗になっている、または反応しないときは、電源とケーブルの接続を確認してください。",
      "それでも解決しないときは、管理者に連絡してください。",
    ],
  },
];

export default async function GuidePage() {
  await requirePageUser();
  return (
    <div className={styles.page}>
      <div className={styles.pageHead}>
        <div>
          <h1 className={styles.pageTitle}>利用ガイド</h1>
          <p className={styles.pageDesc}>受付スタッフの方向けの操作説明です。困ったときはこのページを確認してください。</p>
        </div>
      </div>

      {SECTIONS.map((section) => (
        <section key={section.title} className={styles.panel} aria-label={section.title}>
          <h2 className={styles.panelTitle}>{section.title}</h2>
          <div className={styles.guideGrid} style={{ marginTop: 14 }}>
            {section.steps.map((text, i) => (
              <div key={i} className={styles.guideStep}>
                <span className={styles.stepNum} aria-hidden>
                  {i + 1}
                </span>
                <p className={styles.stepText}>{text}</p>
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
