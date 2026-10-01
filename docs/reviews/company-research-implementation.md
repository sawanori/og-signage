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

## 未完了の確認

本番Worker配備・通常保存からのCronによる少数検証・通常有効化は、この記録作成時点では未実施。PDFの未取得URL記録と異なる企業の実AI応答は最終レビューに基づき追加検証中。最終結果はこの節を更新する。
