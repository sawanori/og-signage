# 企業サイト自動抽出の実装レビュー（2026-10-01）

実装対象は通常保存・承認からの非公開企業情報蓄積。チャット検索やPi表示の追加は対象外。Main保存・配送、分析DB/ジョブ、巡回/Meta、独立品質確認を並列で担当した。

## 適用済みSQLと分離

- Main `og-signage`: `0015_glossy_sharon_carter.sql`。適用後にメンバー6件、outbox0件、migration16件を確認。
- 分析 `og-company-research`: 独立journalの0000〜0002を適用。Main接続にフォールバックしない。
- 分析専用R2 `og-company-research-private`: r2.dev無効、独自公開ドメイン0件をCLIで確認。
- 分析DB/Meta/Crawlの秘密はgitignoredの専用ファイルと分析Workerに限定。値はこの記録へ含めない。

## 検証で見つかり修正した問題

| 所見 | 対応と証拠 |
|---|---|
| 追加テーブルが既存DBテストの期待一覧にない | 初回全体テストは918成功・1失敗。新テーブルを期待一覧へ追加し、既存DB17テストと全体928テストが成功。 |
| 生成された分析バンドルがLint対象に入る | 初回Lintは生成物で12エラー。生成先2か所をignoreへ追加し全体Lint成功。ソースのルールは抑制していない。 |
| Wranglerのmetafile相対パスと出力先の相違 | 初回bundle検査のENOENT後、entryPoint基準のパス解決と出力先を修正。専用ビルド・275入力の境界検査成功。 |
| 人名混在、空白だけの根拠、IPv6ゼロ埋め | 送信保留、正規化後の空根拠拒否、IPv6正規化を追加し回帰テスト成功。 |
| 不明なcrawl使用量を0扱いする | 使用量欠落はnullにして予約維持。実SQLテストで確認。 |
| 期限回収のLIMIT前に現行データを除外していない | 対象外をSQLで先に除外。古い現行データが期限切れデータの回収を妨げない回帰を追加。 |
| crawl開始待ち中のURL削除で返却IDを失う | 使用量台帳へ外部IDを独立保存し、現行jobを更新できなくても取消可能にした。競合テスト成功。 |
| 運用CLIのraw例外出力とretryの試行数 | 秘密を含み得るdriver例外は固定文言にし、retryは新しい試行窓と操作IDを持つ。費用履歴は維持。 |
| 実Meta初回の引用不一致 | `invalid_evidence`で保存前に拒否。初回raw応答未保存のため具体的原因は不明。2回目の実応答は引用検証成功。引用コピーの指示を追加し、根拠不一致のみ予算内最大3回の対象にした。 |

手書きの補助検証ではCrawlパラメータ`crawlUseLevel`の誤記が400で拒否された。アプリ実装は公式の`contentUse`を使用し、訂正したprobeが成功した。一時ローカルprobeの構文エラーも修正後に再実行した。いずれも本番アプリの成功として扱っていない。

## 実APIと通し検証

- Metaのstrict JSON、usage、Crawl作成/poll/pagination/cancelを確認。詳細は `company-research-provider-probe.json` と `company-research-extraction-probe.json`。
- 本番同等render:trueで内部IPと内部IPへのredirectはrecord422、内部IPを返すDNSへのredirectは403。内部本文は取得できなかった。全DNS再束縛・provider内部ネットワークの完全な証明ではない。
- 13ページの取得は10件とcursor10、次の3件で完了を確認。
- 一時libSQL・メモリーR2と実Crawl/Metaで2URLの実行を通し、profile1件・object6件・推定466microUSD。証拠は `company-research-live-pipeline.json`。
- Main保存から実intakeへ渡す2DB統合と、公開/端末configの本文・版・ETag不変、素材404、URL2非混入を自動テストした。

## 本番運用の確認

本番WorkerとSQLを配備し、初回の手動配送後に研究Cronが2URLの取得・抽出・専用DB/R2への保存を完了した。その後、通常UI保存から自動配送・再巡回・現行プロフィール保存が完了し、通常運用を有効化した。PDFの未対応URL記録、異なる企業の情報保持は最終レビューと実API検証で確認済み。

## 最終レビューとCI失敗の修正

- 第三者レビューで、Content-Signalにより片方のCrawl開始が拒否された際に他方も停止するF-01を再現した。観測済みの400応答だけをサイト固有の拒否へ分類し、拒否URLと理由を残して残るURLを処理する。拒否の料金予約はunknownを維持。両順序と認証停止を含む39件を第三者が再実行して成功。`company-research-final-review.md`参照。
- 初回GitHub Actions `36871720898` は939成功・1失敗。`tests/research/ops.test.ts`の最初の統合テストが5161msで既定5000msを超えた。2件目は3989msで成功し、DBロックや個別CLIのtimeoutは記録されていない。
- 4〜5個の別Node/tsxプロセスを実起動する2ケースのみ30秒へ設定。個別CLIの20秒停止と全assertion、グローバルのtimeoutは変更しない。修正後ローカルは946件成功・型検査成功。修正版13914d9のGitHub Actions 36872512310はweb/pi-agentとも成功した。
- Pi回帰は最初のsystem Pythonにpytestがなく実行できなかった。一時venvへ既存requirements-devを入れて再実行し106件成功。CIのpi-agentジョブも初回から成功している。

- Workersランタイムが `redirect: "error"` を拒否する問題をlocal workerdで再現し、3接続先で `manual` と3xx拒否へ変更。aef69e8のGitHub Actions 36876527372は952 Vitest・106 Piテストと全ビルドが成功。本番でも研究ジョブの完走を確認した。
- Mainへ追加した1分Cronは、登録・再登録・待機後も配送が始まらず原因未特定。既存30分Cronの実行は確認できたため、成功したServer Actionの応答後に最大5件を配送し、30分Cronで最大25件を再送する構成へ変更し、本番の保存後配送と30分Cron実行を確認した。プラットフォーム障害が確定したとは扱わない。

- 保存後配送の追加回帰34件と第三者レビューが成功。全体実行中に既存審査UIテスト2件の非同期待機不足が出たため、エラー表示とtransition完了を分けて再操作ボタンを待つよう修正した。全assertionを維持し、67ファイル965件が成功。161bbe4のGitHub Actions 36880151862もWeb全検査とPi106件が成功した。
- Main f6bd4d9e配備後、通常UI保存でrevision2が自動配送された。URL不変のためプロフィールを再利用し、usage502 microUSDのまま追加呼出しなし。pause中の両URL削除revision3も自動配送され、revoked/currentProfileId=nullを確認した。

- 通常UIの2URL再登録revision4から自動配送され、研究Cronだけで世代2が完走した。2ページ・プロフィール1件を保存。本文hash一致でMeta結果を再利用し、追加費用はCrawl19 microUSD。本番検証の累計521 microUSD。世代2のJSON exportと実R2のMarkdownを取得確認済み。
- pause中のURL解除revision5は自動配送成功。検証用メンバーは限定CLI cleanupで削除し、同じ永続outboxのdelete revision6だけを既存dispatcherで手動配送した。全イベント配送済み、分析subject deleted/currentProfile null、Mainは既存6件を維持。公開fixture Worker2件も削除。
- e552479で通常有効化設定を保存。関連26テスト、研究build/275入力検査、停止・canary・非公開設定の検証を通過し、研究Worker f7727cadへ反映した。実環境はpaid=true/canary空/pause=false、匿名404。既存登録の一括分析・Pi ZIP公開は実行していない。
- Mainのoutbox対応済み版f6bd4d9eを復旧対象として記録した。Mainを旧版へ実際に巻き戻す訓練は未実施。分析Workerはpause下で前版bd7417a1へのrollbackと通常版f7727cadへの復旧・再開を実行確認した。
