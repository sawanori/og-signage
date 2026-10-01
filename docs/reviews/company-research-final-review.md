# 企業サイト自動抽出の最終第三者レビュー

レビュー日: 2026-10-01。基準は `docs/implementation-plan.md` の現行1〜15節と `docs/acceptance-checks.json` の check_096〜132。既存の品質レビューで修正済みの所見は再調査せず、計画逸脱と未解消の実装不具合を対象とした。

## 作業記録

- [x] Confirm skill constraints: 担当範囲は読み取りレビューとこの記録のみ。実装・計画JSON・本番設定・秘密値を変更しない。TodoWriteツールは利用可能なツール一覧に存在しなかったため、このチェックリストを記録に用いた。
- [x] 受入証拠表、既存実装レビュー、現行計画を確認する。
- [x] Main outbox、private Worker受付、分析ジョブ、費用予約、保持処理、Crawl/Meta境界を読む。
- [x] 新規所見を一時libSQLで再現し、親担当へ通知する。
- [x] 修正の差分と回帰結果を再確認する。
- [x] Verify skill fidelity: 最終報告が担当範囲・証拠・未検証項目を正しく区別していることを確認する。実装・計画JSON・本番資源への変更は行っていない。

## 新規所見 F-01（P2）

**片方のサイトが巡回開始を拒否すると、もう片方のサイトも処理されない。**

場所: `research/crawler.ts` の `startCrawl` / `request`、`research/jobs.ts` の `runResearchTick` にある巡回開始処理と `failResearchJob`。

Cloudflareの実検証では、Content-Signalで学習利用を拒否するサイトの巡回開始はHTTP 400になる。修正前の実装はこの応答を汎用の非再試行エラー `provider_http_400` とし、企業ジョブ全体を `failed` にしていた。既に取得できた他サイトの資料からの抽出も、残る登録URLの巡回も行われず、拒否サイトのURLと理由がcoverageへ記録されなかった。両URLを独立した情報源として扱い、取得不能部分を記録する計画§2・§7および check_106に不足があった。

再現は既存テスト用の一時libSQLとmigrationを使い、URL1を拒否、URL2を許可サイトとして登録し、巡回開始を実応答と同じ `ProviderError('provider_http_400', false, 400)` にした。100、160、220、280秒の4 tick後の結果は次のとおり。外部APIや本番DBは呼んでいない。

```json
{
  "started": ["https://blocked.example.com/"],
  "jobStatus": "failed",
  "lastErrorCode": "provider_http_400",
  "progress": {},
  "profileCount": 0
}
```

必要な対応は、Crawl開始のサイト固有拒否を安全な固定理由コードへ分類し、そのURLを未取得として記録して次のURLへ進めること。認証・共通設定・未知の400を全て無条件にスキップしてはいけない。拒否URLが1件目の場合と2件目の場合の両方で、許可サイトの資料からpartialプロフィールを生成し、拒否URLの本文をモデルへ送らない回帰が必要。

状態: **resolved**。バックエンド担当の修正を独立再レビューした。

- 開始POSTのHTTP 400で、`success:false`かつ全error messageが記録済みのContent-Signal拒否文言と完全一致した場合だけ `crawl_site_disallowed` とする。任意400、複数理由が混在する400、403認証/設定エラーは従来どおり停止する。
- 拒否URLと固定理由コード、次のURL位置をlease条件付きで保存し、他方のURLへ進む。従来の進行データには後方互換がある。
- 拒否呼出しの費用はusageが不明なため30,000 microUSDの予約を保持する。拒否URLをモデルへ送らず、許可URLだけのpartialプロフィールを保存する。
- URL1拒否とURL2拒否の両順序を、実Crawl開始adapterと記録済みAPI応答を組み合わせた回帰で確認した。

独立再実行: `npm test -- tests/research/provider-adapters.test.ts tests/research/jobs.test.ts tests/research/job-boundaries.test.ts`。2026-10-01 22:54:51 JST開始、3ファイル39件成功、終了コード0。外部有料APIは呼んでいない。

## 追加確認

親担当からの限定依頼により、生成された `dist/server/index.js` のdefault exportを確認した。`scheduled` は `ctx.waitUntil` 相当で生成関数 `Qp(controller.cron)` を呼び、その1分Cron分岐は `COMPANY_RESEARCH` bindingを使うoutbox配送へ接続している。生成entryからscheduledが欠落している所見はない。この静的確認は、本番Cronの初回実行成功を意味しない。

既存証拠表の秘密分離、非公開経路、URL2と分析情報の表示非混入、費用予約、旧ジョブの無効化について、新規の重大な逸脱はこのレビューでは見つからなかった。レビュー開始時点の940件のVitestと106件のPiテスト、型・Lint・ビルド成功は親担当からの実行結果の報告であり、このレビューで全件を再実行したものではない。F-01修正後は上記の対象39件を独立実行し、全体の最終検証は親担当の記録へ委ねる。

## 判定と未完了項目

初回判定は `needs-improvement`、修正後の実装レビュー判定は **pass**。F-01は解消し、新規の未解消実装所見はない。受入証拠表の35項目と今回の再検証を採用し、35 / 37 = **94.6%**を確認済み証拠の充足率とする。これは配備完了率ではない。check_129の最終品質結果の反映とcheck_130の本番canary・停止/復旧記録は親担当の既知の作業であり、F-01と区別する。

本番Cron初回の伝播待ち、通常保存による本番canary、検証用登録の後処理、通常運用の有効化は親担当が確認中。この記録では未確認の配備操作を成功扱いしない。

```json
{
  "complianceRate": "94.6%",
  "verdict": "pass",
  "resolvedFindings": ["F-01"],
  "unfulfilledItems": [
    { "item": "check_129 最終品質証拠の反映", "priority": "medium", "solution": "親担当が修正後の全体検証結果を受入記録へ反映する。" },
    { "item": "check_130 本番canary・停止/復旧記録", "priority": "high", "solution": "親担当が通常保存のCron処理と保管・削除予約を確認し、その証拠に基づいて通常運用を有効化する。" }
  ],
  "qualityIssues": [],
  "nextAction": "実装の追加修正所見はない。親担当の本番確認と最終検証記録を完了する。"
}
```
