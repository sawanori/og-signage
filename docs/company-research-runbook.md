# 企業サイト分析の非公開運用手順

更新日: 2026-10-02（JST）。対象は管理画面の通常保存後に最大2サイトを収集する機能。専用DB・R2・両WorkerとSQL migrationを本番へ反映し、通常UI保存から自動配送・巡回・非公開プロフィール保存まで確認した。**通常運用は有効、canary指定は空、運用pauseは解除済み。** 検証用メンバーと公開fixture Workerは削除済み。

実Crawl・実Metaと一時libSQL・メモリー保管をつないだ2URLの抽出は成功し、プロフィール1件・オブジェクト6件・usage推計466 microUSDを確認した。[隔離統合の証拠](reviews/company-research-live-pipeline.json)は本番稼働確認とは分けて扱う。

## 保存と処理の流れ

管理画面で作成・編集が成功すると、掲載行と配送イベントを同じMain DBトランザクションで保存する。本人申請は承認確定後だけが対象。両URLが空の新規登録では収集しない。保存リクエスト内でCrawlやMetaを待たない。

成功した保存・承認・削除のServer Actionが `after()` で応答後にoutboxを最大5件配送する。失敗した保存では配送を登録しない。未配送イベントは既存の30分Cronが最大25件取得し、天気・メールの成否と独立して再送する。いずれも非公開Service Bindingで分析Workerへ配送する。分析DBへの永続化済み202を確認してから配送済みにする。分析Workerの1分Cronが、1つのジョブの1phaseを進める。処理状態はDBへ記録され、leaseの期限切れや応答喪失から回復する。既存の天気・メールは30分、既存の日次処理は従来の頻度を維持する。

同じURLで進行中の処理がある場合は再利用する。最後の成功巡回から30日以内の再保存でも再利用する。30日後の次の保存で再巡回し、本文hash・モデル・prompt versionが一致する結果はAI呼出しを再利用する。保存と無関係な定期全件再分析や既存全件のバックフィルは実行しない。

取得したHTML/Markdownから見つかるPDF等の未対応資料は、本文を読まずにcoverageへURLと理由を残す。2サイトが異なる企業を示す場合は、別会社のサービスや価格をsourceConflictsへ帰属付きで残し、主企業のサービスへ混ぜない。相反する料金も一方を確定値として選ばず、情報源別に保持する。

## リソースと秘密情報の境界

| 対象 | 所有するもの | 所有しないもの |
|---|---|---|
| Main Worker `sharehouse-signage` | Main DB `og-signage`、既存`MEDIA_BUCKET`、`COMPANY_RESEARCH` Service Binding | 分析DB/R2の読取資格情報、Metaキー、Crawlキー |
| 分析Worker `og-company-research` | 分析DB `og-company-research`、R2 `og-company-research-private` | Main DB、既存`MEDIA_BUCKET`、公開config生成処理 |
| 運用CLI | 分析DBの専用資格情報 | 公開ブラウザ向けの分析API |

分析Workerは `workers_dev:false`、`preview_urls:false`、`routes:[]`。入口はService Binding経由の `POST /internal/sources`だけで、分析結果のGETは存在しない。R2のr2.devと独自公開ドメインも配備時に無効であることを確認する。設定ファイルだけを根拠に、実環境の公開停止が検証済みとは扱わない。

分析Workerに設定する変数名は次のとおり。値をコマンド引数、ソース、コミット、通常ログへ書かない。

| 変数・binding | 用途 |
|---|---|
| `RESEARCH_DATABASE_URL` / `RESEARCH_AUTH_TOKEN` | 分析DBの接続。未設定時にMain DBへfallbackしない。 |
| `MODEL_API_KEY` | Meta API認証。 |
| `CRAWL_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` | Crawl API専用の認証と対象account。 |
| `RESEARCH_BUCKET` | 分析R2 binding。 |
| `RESEARCH_PAID_ENABLED` | 文字列`true`のとき通常の有料処理対象を許可。本番設定は`true`。未指定時は許可しない。新規環境の配備検証中は明示的に`false`とする。 |
| `RESEARCH_CANARY_SOURCE_IDS` | カンマ区切りのsourceId。通常フラグがfalseでも列挙したfixtureだけを許可。 |

ローカル運用の資格情報はgitignore対象の `.dev.vars.research` またはプロセスの環境変数へ置く。分析migrationとCLIのnpm scriptはこのファイルが存在する場合に読み込む。Main用の `.dev.vars` と混同しない。無関係な `weworksignage` と `non-turn-signage` は操作対象外。

## 現在存在する確認コマンド

プロジェクトルートから実行する。成功・失敗と時刻を実装記録へ残す。

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm run check:worker
npm run build:display
npm run check:display
npm run build:research
npm run check:research
```

`build:research`は独立WorkerのWrangler dry-runであり、本番デプロイをしない。`check:research`は生成bundleのMain DB・表示コード混入、秘密値の直接埋込み、Node専用依存を検査する。Mainのbuild成功だけで分析Workerの検証を代用しない。UIに変更がない場合の基本回帰は既存フォーム・QRの操作テストであり、Pi表示ZIPを新規公開する必要はない。

DB構造を追加する実装作業では、次のscriptを使用する。`migrate`は対象DBを書き換えるため、接続先を確認し、一時DBで先に検証する。

```sh
npm run research:db:generate
npm run research:db:migrate
```

分析用journalは `research/db/migrations/`。Main用は `db/migrations/`。今回のMain追加migrationは `0015_glossy_sharon_carter.sql`。分析DBにMain migrationを適用しない。

## 状態・費用・出力の確認

分析DBの資格情報がある運用環境で実行する。これらはMainの管理画面や公開サイネージからは呼び出せない。

```sh
npm run research:ops -- status
npm run research:ops -- usage
```

`status`は直近50ジョブのID、sourceId、phase、status、attempts、nextRunAt、lastErrorCodeと運用controlを返す。原文・プロフィール本文は返さない。`usage`はUTC月・provider・状態ごとの件数、金額、入力・出力tokenを集計する。`chargedMicroUsd`を1,000,000で割るとドル推計額になる。

初期設定の追加API費用枠はUTC暦月でMeta $5、Crawl $5を別々に管理し、Metaは1ジョブ$0.10まで。既存のWorker・DB・R2料金等はこの枠に含まれない。

`reserved`、`started`、`unknown`の金額は安全側に確保した額を含む。請求が確定した額やprovider請求書との一致を意味しない。`settled`はAPIの実usageに基づく精算であり、`cancelled`はネットワーク呼出し前に取り消された予約。

現行プロフィールだけを非公開ファイルへ書き出す例:

```sh
npm run research:ops -- export SOURCE_ID /absolute/private/path/company.json
npm run research:ops -- export SOURCE_ID /absolute/private/path/company.jsonl
```

`SOURCE_ID`と出力先は対象の値へ置き換える。出力先の親ディレクトリを事前に用意し、公開サイトやリポジトリ内の配信ディレクトリへ書き出さない。CLIは既存ファイルを上書きせず、モード0600で新規作成する。revoked/deleted、現行プロフィール未生成の登録は書き出せない。Markdownは専用R2の`.md`で保持し、公開メディア配信へ登録しない。

## 停止・再開・再試行

新しい有料処理を停止する:

```sh
npm run research:ops -- pause
```

DBの運用pauseはcanaryを含めて新規有料処理を止める。次のCronで追跡中Crawlのキャンセルを試みる。providerの即時停止・未確定費用の返金は保証しない。停止中も通常保存、配送受付、delete/revokeの受信、期限到来データの回収は継続する。Main WorkerやCronを停止するとこの回収も止まるため、分析を止めたいだけの場合はこのCLIを使う。

```sh
npm run research:ops -- resume
```

`resume`はDBの運用pauseだけを解除する。環境変数の有料実行フラグ、canary対象、月額・ジョブ予算、provider停止は引き続き適用される。通常フラグをfalseにするだけでは、canary欄に残るsourceIdは停止しない。

| 状態・エラー | 操作 |
|---|---|
| `queued` / `running` / `retry` | 通常は次回Cronを待つ。lease中のジョブを手動増殖させない。 |
| `budget_exhausted` | `usage`で予約・unknown・実使用量を確認する。月額不足は次のUTC月まで待機する。1ジョブ上限は月替わりでリセットされない。 |
| `configuration_required` | credentialsや課金設定を正しいsecretで修復後、該当providerの停止を解除する。 |
| `invalid_evidence` | 厳密な引用照合は維持する。ジョブは予算内で最大3回まで自動再試行する。 |
| `privacy_review_required` / `no_eligible_pages` | 元資料を送信可能と確認できない。本文検査を無効化した再試行は行わない。 |
| `outside_registered_host` / `crawl_record_disallowed`等 | 対象外・robots・取得失敗の理由としてcoverageを確認する。対象外の制約を外して再送しない。 |

修復後の限定再試行:

```sh
npm run research:ops -- unblock-provider meta
npm run research:ops -- unblock-provider crawl
npm run research:ops -- retry JOB_ID
```

`unblock-provider`は指定したproviderの停止だけを解除する。停止ジョブを自動で全件再送しない。`retry`は現行のactiveな登録に属する、failed/configuration_required/budget_exhaustedの特定ジョブだけを対象にする。新しい試行枠は作るが予算と過去の利用履歴は残す。無制限に繰り返さない。URL変更でsupersededとなったジョブや削除された登録は再開できない。

## URL変更・削除・保持期間

片方のURLを変更・削除すると新しい収集対象を作り、旧URLのプロフィールを現行として扱わなくなる。両URLを削除するとrevoke、掲載メンバー削除時はdeleteイベントを保存と同時確定する。遅延したイベントやジョブで古い情報を復活させない。表示OFFはサイネージ上の掲載制御であり、分析停止やデータ削除ではない。

- 生HTMLは取得から7日を期限に回収する。
- 現行プロフィールとその根拠Markdownは登録が有効な間保持する。
- 保護されていない過去版は90日を期限に回収する。
- revoke/delete後は7日を期限にプロフィールと本文の回収対象へ移し、最小の削除記録・課金履歴を保持する。
- R2削除に失敗した場合はDB参照を残して次回Cronで再試行する。期限回収は1回の件数上限があり、障害・滞留時は期限どおりの消去を保証しない。
- Mainの配送済みoutboxは30日後に回収する。未配送・blockedは勝手に削除しない。

## 配備順序とcanary

1. [API実証記録](research-provider-validation.md)の開始条件、専用DB/R2、秘密情報の配置、匿名公開経路がないことを確認する。
2. 分析DBのmigrationを適用し、分析Workerを有料フラグfalse・canary空欄で配備する。
3. Mainの追加migrationを先に適用し、その後Service Bindingとoutbox対応済みMain Workerを配備する。
4. outbox対応済みMain成果物を復旧用に保管する。
5. 開始条件を満たした後、自作の公開fixtureを登録したsourceIdだけを`RESEARCH_CANARY_SOURCE_IDS`へ設定する。通常フラグはfalseのままにする。
6. 通常保存、配送済み202、Crawl、Meta、専用DBのJSON、専用R2のMarkdown、実usage、匿名アクセス不可、公開/端末configへの非混入を確認する。
7. 証拠を受け入れ記録へ反映してから通常の有料実行を有効化する。

**上記の本番canaryを完了して通常運用を有効化済み。** 初回のMeta実抽出と、その後の通常UI保存からの自動再巡回・本文不変時のAI再利用を確認した。合計のAPI使用量からの推計は$0.000521で、請求書の実額ではない。[配備証拠](reviews/company-research-deployment.json)を参照。 個人情報の完全検出やprovider内部SSRFの全挙動を証明したものではない点は、API実証記録に明示している。

現行Mainはバージョン `f6bd4d9e-2269-494e-9068-5aad7ac615e4`（ソース `161bbe4`）で、outbox対応済みの復旧対象として記録した。作成・更新・削除・承認の回帰、実際の通常保存とURL解除を確認済み。Mainを実際に旧バージョンへ巻き戻す訓練は未実施。分析Workerは有料処理pause下で前版bd7417a1へ戻し、通常版f7727cadへ復旧・再開する手順を実行確認済み。

障害時は有料処理をpauseし、分析Workerを必要に応じて前版へ戻す。Mainを戻す場合もoutbox対応済み版に限る。対応前のMainへ戻すと保存・削除イベントが欠落するため、この運用の復旧先として使わない。追加DB表をdropせず、本文やモデルの結果をサイネージへ迂回表示しない。

## 実行証拠の残し方

検証ごとにコマンド、終了コード、時刻、対象task/check、失敗原因、再実行結果を実装記録へ残す。秘密情報、実在サイトの本文、個人情報を通常ログへ貼らない。初回Meta抽出の`invalid_evidence`はraw応答未保存で原因不明だったことと、再実API試験の成功を両方残す。未実施の本番・実機確認をローカルテスト成功で代用しない。
