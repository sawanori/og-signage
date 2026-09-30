# メンバー紹介の本人登録・承認掲載 実装検証記録

2026-10-01。対象は実装計画先頭1〜15節、task_026〜033、check_066〜095。8タスクのコード・運用記録を実装した。既存MVPの履歴・受け入れ結果は変更していない。本番migration適用・デプロイは未実施。

## 検証結果

| 検証 | 結果・証拠 |
|---|---|
| 型チェック | `npm run typecheck` 成功。`/tmp/og-member-quality-typecheck.log`。 |
| Lint | `npm run lint` 成功、警告0。`/tmp/og-member-quality-lint.log`。 |
| Webテスト | `npm test` **51ファイル759件成功**。`/tmp/og-member-quality-test.log`。 |
| Worker | `npm run build` / `npm run check:worker` 成功。回収検索の修正後も再実行。`/tmp/og-member-build.log`。 |
| 表示バンドル | `npm run build:display` / `npm run check:display` 成功。753ファイル、外部参照なし。 |
| Visual | `npm run test:visual` 3件成功。`/tmp/og-member-visual.log`。同一環境の元HEAD `fbc75b5` を隔離コピーで再撮影し、今回版とdashboard/portrait/landscapeのpixelmatch差分はいずれも0画素。元HEAD実行ログは `/tmp/og-member-visual-head.log`。 |
| 320/375/430px | Chromium 153で横はみ出し0、WebP非対応時のJPEG/PNG、応答消失後の429と再送成功、ページエラー0を確認。実機の代用とはしない。 |
| 実ブラウザー主経路 | Chromium `153.0.8010.12`、隔離Worker・ローカルsqld/R2、HTTPモック0。写真付き匿名POST202、未承認非公開、匿名申請画像401、Staff実ログイン・画像200・画面承認、config変更・公開画像200・サイネージ名前/写真、別申請却下を確認。最終DBは申請2件（承認/却下各1）、紹介1件・素材1件、JS例外/画像/フォント失敗0。[保存した結果JSON](member-registration-2026-10-01/e2e-result.json)。 |

受け入れ条件30件のうち自動判定27件は成功。manualのcheck_084（QRカメラ）、check_090（iOS/Android実機）、check_093（実クラウドR2を含む運用確認）は未検証の要素を残すため合格にしていない。部分的に確認済みの結果も `docs/acceptance-checks.json` の各 `verification` に記録した。再現手順は [runbook l節](../runbook.md#l-メンバー紹介の本人登録2026-10-01追加)。

## レビューと修正

- **R1 / P2（修正済み）**：回収と受信再開の順序を強制するテストを追加した。候補取得後に再送がupdatedAtを更新したケースではreceivingを保護する。画像put成功後・pending更新前に回収したケースでは410、画像0バイト、expired維持を確認した。既存の空マーカー先行ケースも維持した。
- **REV2 / P2（修正済み）**：回収検索の状態をパラメーター化すると部分索引を使わなかった。固定の状態SQL式だけへ変更し、実Drizzle/libSQLのクエリをEXPLAINした。回収済み1万件を含むデータで、修正前の `SCAN member_spotlight_submissions / USE TEMP B-TREE FOR ORDER BY` を再現し、修正後は `USING INDEX member_spotlight_submissions_cleanup_idx` を確認した。schema/migration変更はない。
- R1の元レビュアーによる再確認で解消を確認。REV2も修正と試験の整合性を確認し追加指摘なし。管理画面・認証・公開分離・承認・回収の独立読取レビューにもP1/P2の指摘は残っていない。

実装中に同時承認で `SQLITE_BUSY: database is locked` を再現した。SQLITE_BUSYだけ25/50/75msの上限付き再試行へ修正し、尽きた場合は503。同時審査・DB途中失敗のrollbackテストが成功した。

初回Lintの未使用引数警告は除去し再実行成功。初回visualは別vinextサーバーとの競合で失敗し、競合サーバー停止後に3件成功。実ブラウザーE2Eは初回の隔離コピーのfs.allowパス不一致、却下ダイアログのハーネス指定誤り（dialogではなくalertdialog）を修正し、新しい空DBで全経路を再実行して成功した。これらの初回失敗を最終成功と混同していない。

## 未実施の確認

- iOS Safari/Android Chrome実機での写真・キーボード・カメラQRとPi実機。
- 実クラウドR2に対する条件付きput・空マーカー保存の両順序。ローカルR2と条件を再現するテスト用R2での成功は記録済み。
- Cloudflareアカウント全体でのnamespace `4302` 重複確認、本番migration適用とデプロイ。

一時ログのパスは本セッションの記録であり、将来も保持されるとは限らない。恒久テスト・結果JSONとこの要約をリポジトリに保存した。
