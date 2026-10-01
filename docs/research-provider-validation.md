# 企業サイト分析: 外部APIの実証記録

確認日: 2026-10-01。対象は `task_034` と、その後の抽出・品質確認。秘密値、実在会員の登録情報、実在人物の情報はこの記録に含めない。

## 実証できたことと未実証の境界

Meta Muse Spark Contributorのstrict JSON応答と、自作の公開企業サイトfixtureを取得して根拠付きプロフィールへ変換する経路を実APIで確認した。Cloudflare Crawlは公開HTMLの取得、robotsによる除外、Content Signalによる学習用途拒否、キャンセルを確認した。

初期のAPI単体検証と、その後の本番稼働確認は分けて記録する。本番では実WorkerのCronによる2URL取得、実Meta、専用DBへのプロフィール1件と実R2への保存が成功した。初回の配送は手動診断だったが、その後は通常UI保存から自動配送・再巡回・プロフィール保存まで自然なCronだけで完走した。`render:true`でも後述の私的宛先・redirect・ページ送りを追加確認したが、provider内部の全挙動の証明とは区別する。後続の配備・稼働証拠は別に記録する。

一次証拠:

- [本番配備・実行の証拠](reviews/company-research-deployment.json)と[Workers実行環境の修正検証](reviews/company-research-workerd-probe.json)
- [接続・巡回・拒否・キャンセルの結果](reviews/company-research-provider-probe.json)
- [企業情報抽出の入力・実応答・検証済み結果](reviews/company-research-extraction-probe.json)
- [2登録URLの実API・一時DB・メモリー保管の統合結果](reviews/company-research-live-pipeline.json)
- [別企業・料金矛盾fixtureの初回観測](reviews/company-research-conflict-probe.json)と[改善後の再実API結果](reviews/company-research-conflict-retest.json)
- [実応答のローカル回帰fixture](../tests/research/fixtures/meta-extraction-success.json)

## Meta API

| 項目 | 確認した契約・実装 |
|---|---|
| Endpoint | `POST https://api.meta.ai/v1/chat/completions` |
| モデル | `muse-spark-1.3-contributor`。自動で別モデルへ切り替えない。 |
| 認証 | 分析Workerのsecret `MODEL_API_KEY`。値をソース・ログ・Main Workerへ配置しない。 |
| 推論・出力 | `reasoning_effort: minimal`、`max_completion_tokens`。Contributorではmaxを使用しない。 |
| 構造化出力 | `response_format.json_schema.strict: true`。全objectで追加キー禁止、全propertiesをrequiredにする。未記載値はnull/空配列。 |
| ローカル採否 | Zodで型・件数・長さを確認した後、引用を実際のサニタイズ済みMarkdownと照合する。形式成功だけで採用しない。 |
| 利用量 | `prompt_tokens`、`completion_tokens`、cache/reasoningの内訳を記録する。reasoningをcompletionに再加算しない。 |

最初の疎通はHTTP 200、入力29token、出力151token（うちreasoning 130token）。料金表による推計は$0.0000331だった。

企業抽出の初回は、HTTP応答後のローカル検証で `invalid_evidence` となった。入力1,600token、出力1,166token（うちreasoning 362token）、丸め後推計394 microUSD。**初回のraw応答は保存されておらず、具体的な不一致原因は不明**。失敗を成功へ読み替えない。

同じ自作サイトの3ページを使った2回目はHTTP 200で、企業概要、Webサイト制作、映像制作、対応地域、サイトが主張する強み、明示された撮影依頼の制約を保存前検証まで通過した。入力1,600token、出力1,208token（うちreasoning 481token）、丸め後推計402 microUSD。予約は2,491 microUSDだった。実応答は上記JSONに保存した。金額はAPIのusageと料金表による推計であり、請求書の実測額ではない。

この実証後、引用を句読点も含めてコピーし、言い換えは主張のtextだけへ書く指示を追加してv2へ更新した。別企業の情報保持を改善した現在のprompt versionは `company-research-v3`。上記2回目の実証結果はv1であり、v2/v3の新たな実API成功証拠として流用しない。v1実応答を使ったローカル回帰では、現在の厳密な入力・出力検証を通ることを確認している。

根拠不一致には本文を含まない `reason` と `claimIndex` を付ける。再試行はジョブ側で最大3回までとし、各回の予算予約と実usage精算が必要。引用の不一致を無視した保存、別モデルへの切替、無制限の修復呼出しは行わない。

### v2とジョブ実行の隔離統合

続いて同じ自作fixture内の2登録URLを使い、実Crawl・実Meta APIと一時libSQL、メモリー上のオブジェクト保管を接続した。12回のphase実行で`succeeded`となり、プロフィール1件とHTML/Markdownのオブジェクト6件を保存した。prompt versionはv2。Metaは入力1,783token・出力1,221tokenで推計423 microUSD、Crawlは35と8 microUSD、合計466 microUSD（$0.000466）だった。

これは保存した処理履歴と実usageに基づく確認である。phaseの時計を進めたローカル実行であり、本番Cronの経過時間や本番R2への保存の証拠ではない。最終coverageはrobots等の理由を持つpartialで、完全取得とは扱わない。その後の本番実証は下記に分けて記録する。

### 本番Worker・専用DB・実R2での抽出

本番の2URL検証はprompt v3で成功し、プロフィール1件とページ2件を専用DBへ保存した。R2のMarkdown（180 bytes）とHTML（352 bytes）を取得し、検証用企業の本文が存在することも確認した。CLIの現行プロフィール出力も成功した。Meta入力1,810token・出力1,520tokenで推計485 microUSD、Crawl2件の精算が合計17 microUSD、合計502 microUSD（$0.000502）だった。

providerが完了応答内にqueued/disallowedのページ記録を含めたため、coverageは未取得理由付きのpartialである。サイト全ページを取得したとは扱わない。最初のMain配送は診断用の手動実行だったため、この初回結果だけでは通常保存後の自動配送を証明しない。

追加の本番検証では、通常UIで両URLを解除してから同じ2URLを再登録した。保存応答後の自動配送と自然な研究Cronだけで世代2が成功し、2ページ・現行プロフィール1件を保存した。新世代のR2 Markdownも取得確認済み。本文hash・モデル・promptが同じだったため前回のAI結果を再利用し、Metaの追加呼出しは0、Crawl2件の追加費用は推計19 microUSDだった。本番検証の累計は521 microUSD（$0.000521）。同URL再保存で追加費用がないこと、pause中のURL解除でも現行プロフィールが無効になることも確認した。

初回の本番研究Cronでは `redirect: "error"` がWorkersランタイムで拒否され、APIを呼ぶ前に失敗した。ローカルworkerdで同じエラーを再現し、`manual` と3xx拒否へ変更した後、本番で上記の取得・抽出が成功した。プロバイダーキーをredirect先へ転送しない契約は維持している。

### 別会社と相反する料金の保持

check_118として、個人情報のない自作3ページを実Metaへ送った。Alpha Studioの2ページにはそれぞれ基本料金10万円と15万円、別会社Beta LabsのページにはWebサイト制作と20万円を記載した。

初回v2では根拠照合を通過し、Alphaの相反する料金とBetaが別会社であることをsourceConflictsへ保存した。一方、Betaのサービス・価格の主張は省略されていた。入力1,674token、出力1,054token、推計379 microUSD。初回probeには「company.nameは必ずnull」「価格は必ずservices.pricingへ保存」など受入条件より強い期待値も含まれていたため、そのpassed=false全体を実装違反とは断定しない。初回の観測と期待値はそのまま保存した。

v3では、主企業へ統合しない別企業のサービス・価格・対応地域を、会社への帰属と根拠を明示したsourceConflictsとして保持するよう指示を追加した。再実APIでは、AlphaのサービスへBetaの価格を混ぜず、BetaのWebサイト制作・20万円とAlphaの10万/15万円の両方を保存した。会社への帰属、別企業情報の保持、料金矛盾の保持など要求に対応する8条件がすべて成功した。入力1,770token、出力846token、推計347 microUSD。2回合計は726 microUSD（$0.000726）で、許可された検証枠$0.02以内だった。

料金矛盾は一方を勝手に選ぶ理由にせず、sourceConflictsとunknownsで表現する。別会社であることも、情報を消す理由や主企業の実績へ転用する理由にしない。成功応答を[回帰fixture](../tests/research/fixtures/meta-conflict-success.json)へ保存し、引用の情報源を入れ替えた出力を拒否するローカル検証も追加した。

## Cloudflare Crawl API

| 操作 | 契約・観測結果 |
|---|---|
| 開始 | `POST /client/v4/accounts/{account_id}/browser-run/crawl`。成功時の`result`はjob ID文字列。 |
| 結果 | `GET .../crawl/{job_id}`。status、records、metadata、browserSecondsUsedを返す。 |
| ページ送り | `cursor`と`limit`で10件ずつ取得する。実APIで全13件、初回10件/cursor=10、次ページ3件を確認した。 |
| 停止 | `DELETE .../crawl/{job_id}`。実応答200、`success:true`、`result.message`は`Crawl job cancelled successfully`、`result.job_id`が対象ID。 |
| 用途 | `crawlPurposes: [search, ai-input, ai-train]`と`contentUse: full`。Contributorへの学習利用を隠す指定へ変更しない。 |
| 形式 | `html`と`markdown`。Cloudflare側のAI JSON抽出は使用しない。 |

初期設定は1サイト50ページ・深さ5、外部リンクとサブドメイン追跡を無効化、最大2サイト。実装はJavaScriptの描画が必要なページに対応するため `render:true` を指定する。

providerがPDF自体をrecordsに返さない場合も、取得済みHTML/MarkdownのリンクからPDF・Office文書などの未対応URLを抽出する。リンク先を読んだ扱いにせず、URL別の`unsupported_format`をcoverageへ残す。リンクの検出は追加の有料呼出しを発生させない。

| 試験 | 実際の観測 | 限界 |
|---|---|---|
| `Content-Signal: ai-train=no` | `render:false`の開始要求がHTTP 400で拒否された。 | 拒否設定を解除して再試行しない。 |
| 直接の私的IP | `render:false`の開始は200だが、結果はerrored、metadata.status=403、providerエラー1003。 | 開始200だけでは取得成功と判定できない。 |
| 公開URLから私的IPへのredirect | `render:false`で同様にerrored/403/1003となり、内部本文は返らなかった。 | 全redirect・DNS再解決・IPv6・ブラウザ経由の全挙動を証明したものではない。 |
| 私的IPへ解決するホスト | `127.0.0.1.nip.io`は結果errored/403/1002。 | DNS rebindingの全タイミングを検証したものではない。 |
| `render:true`の私的IP・redirect | 直接IPと私的IPへのredirectはerrored/422。私的IPへ解決するホストへのredirectはerrored/403。内部本文は取得されなかった。 | 取得APIのmodeを本番同等にした試験だが、すべての私的宛先・DNS変更時機を列挙したものではない。 |
| 公開の自作企業サイト | `render:true`で3HTMLを取得。`/excluded`はrobotsによりdisallowed。browserSecondsUsed=0.958580078125。 | PDF、OCR、動画、ログイン後のページは対象外。 |
| `render:true`のページ送り | 全13件を10件と3件に分けて取得。browserSecondsUsed=5.80918115234375。 | 小規模fixtureでの確認であり、上限100ページの大規模負荷試験ではない。 |
| キャンセル | DELETE 200。その後の結果は`cancelled_by_user`、対象recordはcancelled。 | ネットワーク中断時の請求確定まで保証しない。 |

追加試験の最初の手書き要求では、存在しない`crawlUseLevel`を指定してHTTP 400になった。この失敗も`rejectedProbeRequest`として証拠JSONに保持した。実装が使用する正しい`contentUse`で再試験し、上表の結果を得た。キャンセル結果のrecordは`metadata:null`を返す場合があり、adapterでは欠落と同じ値へ正規化する。Crawl使用量の欠落は別問題なので0へ変換せず、未知として費用予約を保持する。

SSRF対策は、アプリ側でのURL構文・IP直指定・私的DNS回答の拒否、providerのアクセス制御、取得後の最終URLと登録ホストの再照合を組み合わせる。取得後の検査だけでprovider内部のアクセスを防いだとは主張しない。**provider内部のあらゆるSSRF挙動を証明したわけではない**。未実証の開始条件は通常有料運用を有効化する前に確認する。

## 個人情報・外部資料・根拠の検査

Contributorは公開情報であっても個人情報を無条件に入力できるティアではない。管理登録の氏名、メール、写真、紹介文をモデルへ送らない。サイトのタイトルとURLをモデルへ直接送らず、ページ識別用の不透明なsourceIdと安全判定を通った本文だけを使う。

サイトから取得した本文について、スタッフ紹介、人物の経歴、連絡先等を除去し、人物紹介が混在して分離を確定できない場合は `privacy_review_required` とする。モデル出力も再検査する。次の実例はローカルfixtureで再現・修正した。

- 企業説明に英語の人名と人物の動作が混在する文章。
- 創業者の氏名を含む日本語文章。
- JSON値に出力された英語フルネーム。
- 空白、不可視文字、記号だけを根拠にした主張。
- IPv6特殊用途アドレスのゼロ埋め表記。

**この規則ベースの検査は、未知の氏名・すべての言語・あらゆる個人情報を完全検出する保証ではない**。保留を安全な入力と読み替えず、取得できなかった範囲をcoverageへ残す。サイト内の命令は資料として扱い、モデルに外部ツール・DB更新権限を与えない。推定の弱みは保存せず、未掲載事項はunknownとする。

## 費用の計算と予約

料金表versionは `2026-10-01`。Contributorは月額契約ではなく従量課金のティア。

| 区分 | 単価・処理 |
|---|---|
| Meta通常入力 | 100万tokenあたり$0.10。 |
| Metaキャッシュ入力 | 100万tokenあたり$0.002。 |
| Meta出力 | 100万tokenあたり$0.20。reasoningはcompletion内の内数。 |
| Crawl描画時間 | Browser Runの追加時間単価$0.09/時間を保守的に適用。実装の精算は1秒25 microUSD。含まれる無料時間を先取りして予算をゼロ扱いしない。 |
| Crawl開始前予約 | 1ジョブ1,200秒相当の30,000 microUSD。取得開始から20分で停止を試みる。停止遅延や実usageの超過を完全には保証できない。 |

1ドルは1,000,000 microUSD。Metaはキャッシュを除いた入力、キャッシュ入力、出力から計算し、整数microUSDへ切り上げる。モデル入力の予約は送信JSONのUTF-8 byte数と余裕分を上限token数として用い、言語依存の文字数割り算による過少見積を避ける。

月額予約上限はMetaとCrawlで**別々に$5**。Metaの1企業・1抽出ジョブは$0.10、入力合計50万、出力合計5万token。現在の1呼出しの最大出力は8,192token。本文の選択上限は合計450,000 UTF-8 byteで、超えたページはpartialの理由として残す。

予約は有料呼出し前のDBトランザクションで確定する。応答が不明なら予約を保持する。Crawlの使用量が返らない場合も0へ補完しない。実usageが予約を超えた場合は実測推計を記録し、運用pauseを設定する。DB・R2・Workerの基本料金や税、providerの停止遅延などは別であり、これらを含む総請求額の厳密な上限とはしない。

## 参照した公式資料

- [Meta Models](https://dev.meta.ai/docs/models)、[Pricing and rate limits](https://dev.meta.ai/docs/pricing-rate-limits)、[Structured output](https://dev.meta.ai/docs/structured-output)、[利用規約](https://dev.meta.ai/legal/terms-of-service)
- [Cloudflare Crawl endpoint](https://developers.cloudflare.com/browser-run/quick-actions/crawl-endpoint/)、[Browser Run料金](https://developers.cloudflare.com/browser-run/pricing/)、[Service Bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/http/)

この記録に挙げた実API試験は保存済みJSONへ観測結果を残している。モデルのキー値は出力・文書・fixtureに保存していない。本番への配備結果は本記録と別に扱う。
