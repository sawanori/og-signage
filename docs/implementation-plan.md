# Implementation Plan: メンバー紹介の本人登録・承認掲載

- 作成日: 2026-09-30
- 状態: task_026〜033のコードと運用記録を実装済み。自動検証と隔離Chromium環境の実動作確認は成功。iOS/Android実機、実クラウドR2、本番migration適用・デプロイは未実施。
- 実装・検証記録: 2026-10-01。詳細は `docs/reviews/member-registration-implementation-2026-10-01.md`。
- 対象コミット: `fbc75b5`。
- 対応タスク: `task_026`〜`task_033`。対応受け入れ項目: `check_066`〜`check_095`。
- この文書の1〜15節を今回の追加機能の計画とする。既存MVP計画は末尾に原文のまま保存し、既存タスク・チェックもJSON内に残す。過去の未完了項目を完了扱いにしない。

## 1. Overview

メンバー本人が、共有URLまたはQRコードからスマートフォン用フォームを開き、紹介文と写真を送信できるようにする。管理者・スタッフは既存の「メンバー紹介」で内容を確認し、「掲載する」を押すだけで登録を完了する。

本人の送信内容は専用の申請テーブルに保存する。承認するまでは既存のメンバー紹介・素材一覧・公開サイネージに混ぜない。承認後は既存の編集、表示ON/OFF、削除、配信処理を使う。

## 2. Goal

- メンバー本人: 管理画面のアカウントを作らず、スマートフォンだけで申請を完了できる。
- スタッフ: 写真の受け取り、文章の転記、素材の再アップロードをなくし、内容確認と承認だけにする。
- 運用: 既存のメンバー紹介の見た目と掲載済みデータを維持する。
- 操作目標: 会社名・名前だけなら1画面で入力できる。写真と任意項目を含む通常申請は1〜2分を目安とする。時間は実機確認で測定し、保証値とはしない。

## 3. Current State

| 確認箇所 | 現在の実装と今回への影響 |
|---|---|
| `app/admin/spotlights/page.tsx` / `components/admin/spotlights-view.tsx` | 管理ログインが必要。一覧、検索、五十音絞り込み、追加、編集、削除がある。 |
| `app/admin/_actions/spotlights.ts` | 作成・編集・削除のたびに `requireRole("staff")` でDB照合済みの利用者を取得する。 |
| `lib/validators.ts` | 会社名30文字・名前20文字は必須。ふりがな40文字、肩書き30文字、ひとこと30文字、紹介文60文字、タグ3つ・各10文字、写真・ロゴは任意。文字数はUnicodeコードポイント単位。 |
| `db/schema.ts` / `lib/services/spotlights.ts` | `member_spotlights` は `enabled` と `revision` を持つが、承認状態は持たない。通常作成は表示ON。 |
| `lib/config-builder.ts` | `enabled=true` の紹介を配信する。ふりがなは配信しない。未承認申請を同じテーブルに置くと、通常の表示スイッチで公開できてしまう。 |
| `lib/client/upload.ts` | `prepareImage` は画像を長辺1920px以下のWebPに変換するが、WebP出力できないブラウザでは例外にする。公開フォームでは同じ寸法・向きの条件を使う専用画像準備関数を設ける。 |
| `db/schema.ts` / `lib/services/media.ts` | `uploads.user_id` は管理利用者への必須外部キー。既存アップロードAPIを匿名向けに緩めることはしない。 |
| `worker/public-signage-relay.ts` | 公開configが参照する素材のみ匿名配信する。申請を通常の `media` に作らなければ既存の公開経路に出ない。 |
| `lib/csrf.ts` / `proxy.ts` | `/api/` 配下の更新リクエストは、端末APIを除いて同一Originを要求する。新規匿名POSTにも適用する。 |
| `components/signage/SpotlightCard.tsx` | 写真・ロゴのURLを受け取れる。送信前のローカル画像と管理者用画像によるプレビューに利用できる。メンバー紹介の表示枠は現在横型にある。 |

計画前の調査ではWebテスト639件が成功した。実装後の2026-10-01検証では型チェック・Lint・51ファイル759テスト、Worker/表示バンドルのビルドと検査が成功した。隔離した実Worker・ローカルsqld/R2を使ったChromiumの申請・承認・公開表示・却下も成功した。iOS/Android/Pi実機の反映は未検証であり、既存のPi同期問題を解決したとは扱わない。

## 4. Scope

1. ログイン不要の `/members/register` と、スマートフォン向けの入力・内容確認・送信完了表示。
2. 既存の紹介項目、任意の本人写真1枚・会社ロゴ1枚、掲載先の説明と送信時の同意。
3. 申請専用の匿名POST、画像の非公開保存、連続送信の制限、同一送信の再試行。
4. `/admin/spotlights` の「掲載メンバー」「確認待ち」の切り替え、件数表示、承認・却下。
5. 登録URLのコピー、QRコードの表示・PNG保存。受付で配布できるようにする。
6. 未承認画像をスタッフだけが確認する取得経路。
7. 受信途中・却下済み画像の掃除と、承認済み素材を保護する処理。
8. 既存機能の回帰確認、スマートフォン実機確認、運用手順への追記。

## 5. Non-Scope

- 本人の登録後編集リンク、メール認証、アカウント作成、本人確認。後からの修正は既存管理画面で行う。
- メール・LINE・Slack通知、外部フォーム連携、CSV一括登録、名刺OCR。
- 審査前の自動掲載、承認画面での文章修正、一括承認。今回の審査は確認・承認・却下に限定する。
- 管理画面全体のスマートフォン対応。本人登録画面だけを対応する。
- サイネージ内の登録用QRの自動配置、既存フッターQRの自動置換、縦型へのメンバー枠追加。
- Pi Agent、既存アップロードの認証条件、既存公開素材判定の仕様変更。
- 新規有料サービス、画像変換用サーバー、依存パッケージの更新。
- 再読み込み・別端末をまたぐ下書き復元。同一送信の再試行保証は開いているフォーム内とし、結果不明時には画面を閉じずに再確認するよう案内する。

## 6. Assumptions

ユーザーに追加確認を求めず、次を初期案として計画した。実装前に方針変更があれば本節と対応チェックを更新する。

- 登録用URLは施設共通の固定URL。受付でQRやリンクを案内し、メンバーのアカウントは不要。
- 掲載承認は現在メンバー紹介を編集できるStaffとAdministratorの両方が行う。
- 必須項目は既存と同じ会社名・名前のみ。会社名の画面ラベルは「会社名・所属」とし、写真・ひとことなどは任意にする。
- 未承認申請は自動掲載しない。未審査の申請は期限で勝手に削除しない。
- 写真とロゴはブラウザで縮小する。WebP出力が可能なら使い、非対応なら写真はJPEG、透過ロゴはPNGを使う。APIはJPEG・PNG・WebPを受け付け、送信後の各ファイルは2MiBまで。multipart全体は5MiBまで。元画像の選択上限は既存と同じ20MiB。
- HEIC変換ライブラリは追加しない。JPEG・PNG・WebPを選べるよう案内し、読めない形式では送信前に日本語の説明を出す。
- ログイン用とは別のRate Limiting bindingを用い、同一IPについて5回/60秒を初期値とする（2026-10-01のレビュー後に20回/60秒へ変更。15節参照）。同じ施設の回線を共有すると制限も共有されるため、待ち時間を画面に示す。
- 氏名と写真が館内サイネージおよびログイン不要のWebサイネージで表示されることをフォームで説明し、同意を必須にする。連絡先は収集しない。
- 公開Webでは承認後の次回設定取得で掲載データに入る。通信正常時の目安は30秒程度。人数分のスライド巡回時間は別であり、承認直後に必ず当人が画面へ出るとはしない。

## 7. Architecture Impact

### フロントエンド

公開登録画面を管理レイアウトの外に追加する。既存管理フォームは認証付き素材ピッカーや表示スイッチを持つため、そのまま公開しない。公開フォームを新設し、入力制約と表示カードを再利用する。公開用の画像準備関数は既存と同じ長辺1920px・画像の向きの条件を使い、WebP出力可否に依存させない（2026-10-01のレビュー後に長辺1280px・1枚約400KBへの圧縮に変更。15節参照）。既存の管理アップロード関数は変更しない。

### バックエンド・認証

匿名で許可する操作は申請POSTだけ。申請一覧、申請画像取得、承認・却下は既存のStaff認証を使う。Origin検査の例外を追加せず、匿名利用者から `enabled`、状態、審査者、既存紹介ID・素材ID、R2キーを受け付けない。申請内容を取得する公開GETは設けない。

### DB・R2と承認

新規 `member_spotlight_submissions` が申請本文と画像情報を保持する。状態は `receiving`（受信中）、`pending`（確認待ち）、`approved`（掲載済み）、`rejected`（却下）、`expired`（受信中断の期限切れ）。`pending` のみ審査対象とする。

R2保存前にDBへ申請とサーバー生成のキーを記録する。全ファイル保存後に `pending` へ切り替える。通常の `media` と `member_spotlights` はこの段階では作らない。

承認時は画像の存在・サイズを確認し、1つのDB書き込みトランザクションで、申請の状態・revision確認、`media` 登録、`member_spotlights` 登録、申請の承認状態更新を確定する。画像のR2キーはそのまま使い、コピーしない。通常の素材削除と参照保護は承認後の画像にも適用する。

### 送信再試行

初回送信時に、UUIDの `requestKey`、正規化した本文・同意、変換済み画像Blobを1つの送信内容として固定する。サーバーは本文と受信画像SHA-256からfingerprintを作り、DBの一意制約で同じkeyの申請を1件にする。

ブラウザは「編集中」「送信中」「結果不明」「受付済み」を区別する。

- 送信中と結果不明の間は、文面・同意・画像の編集、新しいkeyの発行、新規送信を禁止する。通信切断、タイムアウト、5xx、受付成否を解釈できない応答は結果不明とする。「送信結果を確認」から、固定済みの同じkey・本文・Blobだけを再送する。
- 202を受け取ったら受付済みとし、編集・再登録を表示しない。送信後の修正はスタッフへ依頼する。410なら元の申請は期限切れで掲載されないことが確定するため、入力を保持して編集と新しいkeyでの明示的な送信を許可する。
- 未解決の送信がなく、その回の要求が保存前に拒否されたと分かる400/403/413/415/429応答を受けた場合だけ、入力修正を許可する。429は待ち時間後に再試行する。一度結果不明になった後の再送が400や429等で拒否されても、最初の受付成否は未確定なので編集ロックを解除せず、新しいkeyも発行しない。409も自動的に新規送信へ切り替えず、スタッフへ相談する案内を出す。
- 画面内の再試行でBlobを再変換しない。結果不明の間は画面を閉じずに再確認する案内を表示する。再読み込み・別端末での重複防止は今回の保証範囲外とする。

サーバー側は次の規則を守る。

- 同じkey・同じfingerprintで `receiving` なら、開始時に `updatedAt` を条件付き更新する。画像の保存は必ず `onlyIf: { etagDoesNotMatch: "*" }` による新規作成とし、既存画像や掃除済みの空マーカーを上書きしない。
- 条件不成立でputがnullを返したら、申請状態と既存オブジェクトのサイズを読み直す。同じfingerprintの `receiving` で期待サイズの画像が存在する場合だけ再利用する。0バイトの空マーカー、画像欠落、保存エラーを成功扱いにしない。`pending` への更新にも `receiving` の条件を付け、審査・期限切れを上書きしない。
- すでに `pending/approved/rejected` なら一般的な202受付済み応答を返し、状態・本文・素材IDを公開せず、再登録しない。keyが同じで内容が違えば409。`expired` は410とする。
- 途中失敗では行とR2キーを残し、失敗したリクエスト内で画像を削除しない。日次処理で画像を空マーカーに置き換え、すべての対象キーの処理成功をDBへ記録したら回収を終了する。詳細は10節に定める。

### インフラ・公式資料

新規bindingは `SPOTLIGHT_SUBMISSION_RATE_LIMITER`。本文を読む前に制限し、ログイン用とは別のnamespaceを割り当てる。namespace番号は `4302` を設定した。リポジトリの既存 `4301` と検証用 `4201` とは異なるが、アカウント全体の重複確認は未実施であり配備前に確認する。これは概算制限であり、厳密な全拠点共通の送信数・課金上限とは扱わない。仕様確認: [Cloudflare Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)（2026-09-30参照）。

Canvasは指定形式を出力できない場合にPNGを返すため、要求した形式名ではなく実際のBlobのMIMEを確認する。公開画像準備ではWebP非対応時のJPEG/PNG経路を用意し、変換後のBlobを保持して再送時のfingerprintを安定させる。仕様確認: [MDN HTMLCanvasElement.toBlob](https://developer.mozilla.org/en-US/docs/Web/API/HTMLCanvasElement/toBlob)（2026-09-30参照）。

既存の `MediaBucket` を使い、`put` 専用のオプション型にだけ `onlyIf` を追加する。multipart作成と共有しているHTTPメタデータの型は維持する。条件不成立時のnullを扱い、空マーカーの作成は条件なしのputとする。単発の小容量画像なのでR2マルチパートを増設しない。

仕様確認: [R2 Workers API reference](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)、[R2の整合性モデル](https://developers.cloudflare.com/r2/reference/consistency/)、[Cloudflare公式実装のワイルドカード条件](https://github.com/cloudflare/workerd/blob/main/src/workerd/api/r2-bucket.c%2B%2B#L1226)（2026-09-30参照）。条件付き保存と強整合性を根拠にするが、実R2の競合試験は未実施であり、実装時の隔離環境で確認する。Context7 MCPは本セッションで利用できず、公式資料を直接参照した。

## 8. UI Plan

### 本人用 `/members/register`

- 1列、幅320px〜430pxのスマートフォンを基準とし、PCでは最大幅を設け中央に表示する。管理画面の最小幅を継承しない。
- 冒頭に「メンバー紹介を登録」と掲載先・承認後に表示される説明を置く。
- 会社名・所属、名前、ふりがな、肩書き、ひとこと、写真を主な入力欄とする。紹介文・タグ・ロゴは「詳しい情報」にまとめる。
- 入力制約は3節の現行値を維持する。文字数、欄ごとのエラー、画像処理中、取り消し・差し替えを表示する。
- 「掲載イメージを確認」で `SpotlightCard` を使った縮小プレビューを出す。固定寸法の枠と必要な書体・CSS変数をラッパーで与え、文字や写真の切れ方を確認できるようにする。カード本体のデザインは変更しない。
- 同意後に「紹介を送信」。画像準備中は送信を止め、送信中・結果不明は編集と新規送信を止める。結果不明では「送信できたか確認できません。画面を閉じずに送信結果を確認してください」と表示し、「送信結果を確認」で固定済みの同じ内容だけを再送する。確定した保存前エラーと結果不明後の再送エラーは7節の規則で区別する。
- 成功時は「送信しました。スタッフの確認後に掲載されます」。修正が必要な場合はスタッフへ依頼する案内を出す。完了画面からの編集・新規送信は設けず、既存紹介のIDや管理画面へのリンクは返さない。
- 送信を押す前の画像はBlob URLによるローカルプレビューのみ。差し替え・画面終了時に破棄する。
- task_030の開始時に、検証対象のiOS Safari／Android Chromeで写真選択・画像変換を先に確認してOS/ブラウザ版を記録する。WebP非対応を模したテストも行い、JPEG/PNGの経路で送信できることを確認する。続けて回転、画面キーボード、エラー、再送信を確認する。ブラウザ固有の画像変換失敗は未検証のまま成功扱いにしない。

### 管理用 `/admin/spotlights`

- 既存一覧の上に「掲載メンバー」「確認待ち（N件）」を追加する。件数はページ取得・承認・却下後の再取得で更新する。常時ポーリングは追加しない。
- 確認待ちは古い申請から並べ、氏名・所属・申請日時を表示する。選択すると全入力内容、同意日時、写真・ロゴ、掲載プレビューを確認できる。
- 「掲載する」は1クリックで承認。「却下」は既存の確認ダイアログの様式を使う。
- 成功時は一覧と件数を更新する。競合時は「他のスタッフが処理しました」と知らせ、古いrevisionを持つ詳細画面を閉じて再取得する。
- 既存の追加・検索・五十音・名前順・編集・削除は維持する。承認済み内容の修正は既存の編集画面を使う。
- 「登録用URL・QR」を開くと、現在のサイトURLを使った絶対URLのコピーとQR表示・PNG保存ができる。QR生成は既存 `qrcode` 依存で行い、外部サービスへURLを送らない。

## 9. API Plan

| 操作 | 認証・入力 | 応答・責務 |
|---|---|---|
| `POST /api/spotlight-submissions` | 匿名可、同一Origin、専用レート制限。multipartの `data` JSON、任意 `photo`、任意 `logo` | 受付完了または同一内容の受付済みは202 `{ data: { accepted: true } }`。 |
| `GET /api/spotlight-submissions/[id]/images/[kind]` | Staff以上。`kind` は `photo` または `logo` | 確認待ち画像のみ返す。存在しない・対象外の申請/画像は404。`Cache-Control: private, no-store`、検査済みMIME、nosniff。 |
| `approveSpotlightSubmissionAction(id, revision)` | Staff以上、既存Server Action認証・Origin検査 | 成功時に掲載メンバーID。approvedへの同一承認再送はrevisionによらず処理済み結果を返す（紹介削除後はID null）。pendingの古いrevision、却下/期限切れは409。 |
| `rejectSpotlightSubmissionAction(id, revision)` | Staff以上 | 成功時に却下結果。rejectedへの同一却下再送はrevisionによらず成功。pendingの古いrevision、承認済み/期限切れは409。 |

`data` の項目は `requestKey`、会社名・氏名等の文面、`consent: true` のみ。画像は添付バイトで受け、素材ID、ファイル名、R2キー、ハッシュ、公開フラグを信用しない。画像の名前・SHA-256・サイズ・MIMEはサーバーが決める。dimensionsは新規mediaでnullを許容し、申告値を必須にしない。

本文制限は `Content-Length` による早期拒否に加え、実際のストリームを最大5MiBまで読み取ってからmultipart解析する。長さヘッダーなし・偽装でも上限を超えた時点で413とし、DB/R2を書かない。`data` は10KiBまで、画像は各1つ・2MiBまで。重複フィールド、余分な添付、JSON不正を400にする。画像はJPEG・PNG・WebPのみ受け、既存の先頭バイト判定を使い、宣言MIMEとの不一致・空ファイル・動画・SVGを拒否する。

エラーは既存の `{ error: { code, message } }` にそろえる。400=入力、401/403=認証・権限・Origin、404=対象なし、409=競合、410=中断申請の期限切れ、413=容量超過、415=形式不正、429=送信制限、503=保存先の一時失敗。429では `Retry-After: 60` と待ち時間の説明を返す。予期しない失敗を成功に変換せず、受付番号や本文・写真・生IPをアプリログへ出さない。

## 10. Database Plan

### 新規テーブル `member_spotlight_submissions`

| 列 | 型・条件 |
|---|---|
| `id` | サーバー生成UUID、主キー。 |
| `request_key` | フォーム生成UUID、一意、再送識別用。認可用トークンとしては使わない。 |
| `request_fingerprint` | 正規化本文・同意・受信画像SHA-256を含むハッシュ。 |
| `payload` | 紹介文面の検証済みJSON。受信中/確認待ちでは必須。却下・期限切れの掃除後と、承認時（文面は紹介へ写す）にnull。 |
| `photo_file` / `logo_file` | 任意JSON `{ r2Key, mimeType, size, sha256 }`。R2キーは拡張子を付けない `member-submissions/<server-id>/photo` または `logo`。MIMEは検査済み値で配信する。回収後もキーを保持するが、回収完了した行は再処理しない。 |
| `status` | receiving / pending / approved / rejected / expired。DBのCHECK制約も設定する。 |
| `revision` | 0開始。審査で条件照合し、状態確定時に増やす。 |
| `consented_at` / `consent_version` | サーバー時刻と説明文の版（初版1）。 |
| `created_at` / `updated_at` / `submitted_at` | UNIX秒。submitted_atは受信完了時、受信中はnull。 |
| `reviewed_at` / `reviewed_by` | 審査日時とusersへのnullable外部キー。ユーザー削除はSET NULL。 |
| `approved_spotlight_id` | member_spotlightsへのnullable外部キー・一意。紹介削除時SET NULL。approved状態は戻さない。 |
| `cleanup_next_at` | nullable UNIX秒。却下/期限切れ確定時に現在時刻、回収失敗時は現在時刻+24時間、完了後はnull。その他の状態ではnull。 |
| `cleanup_completed_at` | nullable UNIX秒。全対象キーの空マーカー保存成功後に設定する。画像なしはDB更新だけで設定できる。 |

索引は `request_key` UNIQUE、`(status, submitted_at)`、`(status, updated_at)`、`approved_spotlight_id` UNIQUEに加え、未回収のrejected/expiredに限定する `(cleanup_next_at, id)` 部分索引を置く。既存テーブルの列削除・既存メンバーの再分類はしない。`npm run db:generate` により `0010_parched_fat_cobra.sql` と `meta/0010_snapshot.json` を生成し、journalへ追加した。一時DBで0009までの既存紹介を保持したまま適用できることを確認した。既存テーブルの削除・改名は含まない。

承認は `status=pending AND revision=入力値` による条件付き変更と紹介・素材の挿入を同一トランザクションにする。途中失敗は全変更をrollbackし、確認待ちに残す。紹介を後日削除した後でも承認再送で再作成しない。

### 掃除と画像の所属

- 既存日次Cronに申請専用掃除を追加する。24時間以上更新されていない `receiving` を `updated_at, id` 順にSQLのLIMITで最大50件取得し、状態とupdated_atの再照合付きで `expired` に変更する。再送側のupdated_at更新と同時に成功させず、期限切れ確定時に `cleanup_next_at=現在時刻` とする。却下時も同様に次回回収時刻を設定する。
- 回収は `status IN (rejected, expired) AND cleanup_completed_at IS NULL AND cleanup_next_at <= 現在時刻` の行だけを、`cleanup_next_at, id` 順に最大50件取得する。全件取得後の切り出しや、同じ実行内で対象がなくなるまで繰り返す処理はしない。
- 各キーが `media.r2_key` に存在しないことを確認し、記録された写真・ロゴのキーへ0バイト・`application/octet-stream` の空マーカーを条件なしでputする。まだ画像が保存されていないキーにもマーカーを作る。画像保存が先ならマーカーが内容を置き換え、マーカーが先なら遅延した画像保存の新規作成条件が成立しない。
- 全キーへのマーカー保存が成功して初めて、`cleanup_completed_at` を設定し、`cleanup_next_at` と本文payloadをnullにする。画像なしも回収完了にできる。request_key・fingerprint・状態・キー情報は再送判定と記録のため保持する。完了した行は以後の回収検索から外し、R2へ再アクセスしない。
- R2エラー、通常mediaとのキー重複、DB完了更新失敗では完了扱いにしない。行単位で失敗を記録し、可能なら `cleanup_next_at=現在時刻+24時間` に更新して次の対象へ進む。これにより失敗行が古い未処理行の前に居座らない。DB自体へアクセスできない場合は失敗として終了し、次の日次処理で再試行する。
- `pending` を期限で削除しない。`approved` の画像は通常mediaの所有物として扱い、申請掃除では触らない。承認後の通常素材削除は参照保護と7日間の猶予を維持し、`purgeDeletedMedia` の最終処理だけ、アプリ生成の `member-submissions/<id>/photo|logo` キーを空マーカーへ置換する。成功後にmedia行を削除する。それ以外の既存キーは従来どおり物理削除する。
- 空マーカーは遅延保存を防ぐため保持し、`member-submissions/` を物理削除するライフサイクル規則や一括削除を設定しない。完了済みのDB記録と小さなR2オブジェクトは残るが、過去分への日次操作は増えない。運用手順にこの制約を記録する。
- DBとR2は同じトランザクションにできないため、R2書き込み前に必ず追跡用DB行を保存する。テスト用R2も条件付き保存を再現し、遅延保存と回収の両順序、マーカー保存途中の失敗、DB完了更新失敗、50件超の繰越、失敗行の後続処理を検証する。

## 11. File-by-File Plan

| 変更 | 対象 | 目的 | リスク |
|---|---|---|---|
| modify | `db/schema.ts` | 申請テーブル、状態制約、外部キー、索引。 | high |
| create | `db/migrations/0010_parched_fat_cobra.sql` / `db/migrations/meta/0010_snapshot.json` | 追加のみのマイグレーション。既存journalも更新する。 | high |
| modify | `lib/validators.ts` | 紹介文面の共通制約を公開し、既存入力の挙動は保つ。 | medium |
| create | `lib/spotlight-submissions.ts` | 公開入力・DTO・容量・状態・同意版の共通契約。DB/R2/認証をimportしない。 | medium |
| create | `lib/services/spotlight-submissions.ts` | 受付・再送・非公開取得・承認・却下・件数上限と完了状態を持つ掃除。 | high |
| modify | `lib/r2.ts` | put専用オプションに新規作成条件を追加し、multipartの型は維持する。 | medium |
| modify | `lib/services/media.ts` / `tests/services/media.test.ts` | 申請由来キーの最終削除だけ空マーカー保存にし、既存素材削除・猶予・参照保護を回帰確認する。 | high |
| create | `app/api/spotlight-submissions/route.ts` | 本文制限、専用rate limit、multipart検証、匿名受付。 | high |
| create | `app/api/spotlight-submissions/[id]/images/[kind]/route.ts` | Staff専用画像取得。 | high |
| create | `app/admin/_actions/spotlight-submissions.ts` | 認証付き承認・却下。 | high |
| modify | `wrangler.jsonc` / `types/cloudflare-workers.d.ts` / `tests/stubs/cloudflare-workers.ts` | 専用rate limit binding・型・テスト差し替え。 | medium |
| create | `app/members/register/page.tsx` | モバイル用メタデータ・viewport・公開入口。 | medium |
| create | `components/members/spotlight-registration-form.tsx` / `registration.module.css` | 入力・画像選択・確認・送信・完了。 | medium |
| create | `lib/client/submit-spotlight.ts` | 画像準備結果の利用、容量確認、送信内容の固定、結果不明時の編集制御、同じkey・BlobでのPOST。 | medium |
| create | `lib/client/prepare-spotlight-image.ts` | 公開用の縮小・向き反映とWebP/JPEG/PNG出力。既存管理用変換は変更しない。 | medium |
| create | `tests/public/spotlight-image.test.ts` | WebP非対応を模したMIME切り替え、向き・寸法・容量を確認。 | medium |
| create | `components/members/spotlight-preview.tsx` | 既存SpotlightCardをフォームと審査画面で縮小表示。 | medium |
| modify | `app/admin/spotlights/page.tsx` / `components/admin/spotlights-view.tsx` | pending取得、件数、タブ、既存一覧との接続。 | medium |
| create | `components/admin/spotlight-submissions-view.tsx` / `spotlight-registration-share.tsx` | 審査詳細、競合後再取得、登録URLとQR。 | medium |
| modify | `worker/scheduled.ts` | 日次の申請掃除を追加。既存掃除の条件は変えない。 | high |
| modify | `tests/db/schema.test.ts` / `tests/lib/validators.test.ts` | 追加テーブルと既存入力制約の回帰。 | medium |
| create | `tests/services/spotlight-submissions.test.ts` / `tests/helpers/spotlight-bucket.ts` | 再送・保存失敗・承認/却下競合・R2保護。 | high |
| create | `tests/api/spotlight-submissions.test.ts` / `tests/api/spotlight-registration-flow.test.ts` | 境界検査・Staff認証・受付から配信まで。 | high |
| create | `tests/public/spotlight-registration-form.test.tsx` / `tests/public/submit-spotlight.test.ts` / `tests/public/spotlight-registration-flow.test.tsx` | 公開フォーム、送信状態、受付応答消失からの実サービス再送。 | medium |
| create | `tests/admin/spotlight-submissions-view.test.tsx` / `tests/admin/spotlight-registration-share.test.tsx` / `tests/admin/spotlight-submissions-integration.test.tsx` | 審査・QR共有・実Action/掲載プレビューとの接続。 | medium |
| create | `tests/e2e/seed-member-registration.ts` / `tests/e2e/member-registration.mjs` | 空の専用ローカルDBを準備し、HTTPモックなしの実ブラウザー主経路を再現。 | medium |
| modify | `tests/admin/spotlights-view.test.tsx` / `tests/lib/csrf.test.ts` / `tests/worker/scheduled.test.ts` | 既存管理・Origin・掃除の回帰。 | medium |
| verify | `tests/api/public-signage.test.ts` / `tests/api/device.test.ts` | 既存公開/端末配信は変更せず回帰実行。新機能の配信接続は追加の統合テストに集約。 | medium |
| modify | `docs/runbook.md` / 計画・タスク・受け入れ条件の3ファイル | 共有・審査・回収・配備順序、実測結果と未検証項目を記録。 | low |
| create | `docs/reviews/member-registration-implementation-2026-10-01.md` / `docs/reviews/member-registration-2026-10-01/e2e-result.json` | 最終検証と修正履歴、隔離実ブラウザー結果の保存。 | low |

`lib/config-builder.ts`、config schema、既存素材API、workerの公開relay、Piコードは変更対象にしない。公開防止は申請の隔離で実現する。

## 12. Implementation Order

| 着手条件 | タスク | 完了時の成果 |
|---|---|---|
| 先行作業なし | task_026 | 申請データ・共通入力型・DTO・予定するservice/Actionの引数と戻り値・エラー契約を確定し、追加migrationを一時DBで確認できる。 |
| task_026完了 | task_027 | R2付き受付・再送がサービス層で動き、未承認データが隔離される。 |
| task_027完了 | task_028 | 承認・却下・競合制御が動き、1申請につき最大1件だけ掲載される。 |
| task_027完了 | task_029 | HTTP受付、本文上限、rate limit、Staff専用画像確認がつながる。 |
| task_026完了 | task_030 | 本人がスマートフォン用画面から申請できる。task_029完了後の受付APIと共通プレビューの接続テストまで完了する。 |
| task_026完了 | task_031 | スタッフがQRを共有し、確認待ちから承認・却下できる。task_028・029・030完了後のservice/Action・画像API・共通プレビューの接続テストまで完了する。 |
| task_028完了 | task_032 | 中断・却下画像を掃除し、承認済み素材が保護される。 |
| task_026〜032完了 | task_033 | 主経路・回帰・モバイル・ビルド確認と運用記録がそろう。 |

今回のtask_026〜033では、task-list.jsonの`dependencies`を着手前に完了が必要なタスク、`completion_dependencies`を完了判定前に追加で完了が必要な接続先タスクとする。後者がない場合は追加依存なし。task_026で共通契約を確定した後、backendの残作業と公開UI・管理UIを並行して進められる。接続先が未実装の間は確定した契約に沿って独立実装するが、仮の応答による画面テストだけでtask_030・031を完了にしない。

| 担当 | 所有範囲 |
|---|---|
| backend | task_026〜029・032。DB・migration・共通入力型/DTO・service・Action・API・R2・binding・Cronと対応テスト。共通契約の変更は両UI担当へ共有する。 |
| public UI | task_030。`app/members/`、`components/members/`（共通の`spotlight-preview.tsx`を含む）、公開用client処理と`tests/public/`。 |
| admin UI | task_031。`app/admin/spotlights/page.tsx`、対象の`components/admin/`と`tests/admin/`。共通プレビューはpublic UI担当の実装を利用する。 |
| 統合 | task_033。主経路・既存配信の統合テスト、全体検証、運用記録と計画・受け入れ結果の更新。共有ファイルの変更を担当間で調整する。 |

所有範囲をまたぐ変更は担当間で調整し、他担当の編集を戻さない。新規ルートは全タスクが揃うまで本番へ配備しない。実装段階では追加migrationを先に適用し、新旧コードが共存できることを確認してから新コードを配備する。

## 13. Verification Commands

現在 `package.json` に存在する以下を使用した。実装後の終了コードはすべて0。型チェック/Lint/51ファイル759テスト、Workerのbuild/check、表示bundleのbuild/check、visual 3件を確認した。コマンド出力・初回失敗と再実行結果は実装検証記録に残す。

- `npm run typecheck`
- `npm run lint`
- `npm test`
- `npm run build`
- `npm run check:worker`（build成功後）
- `npm run build:display`
- `npm run check:display`（build:display成功後）
- `npm run test:visual`（既存サイネージ・管理画面の見た目の回帰。本人フォームの通信確認をこれだけで済ませない）

実装用に存在するコマンドは `npm run db:generate`、`npm run db:migrate`、`npm run dev`。migrationの検証はまず `tests/helpers/temp-db.ts` の一時DBを使い、本番接続先には実行しない。

手動では隔離したR2で、画像の条件付き新規保存と空マーカー保存を両順序で実行し、条件不成立のnull、0バイトの保持、回収完了後に画像が復活しないことを確認する。実行結果はcheck_093に記録する。

手動では隔離した検証環境で、iOS SafariとAndroid Chromeの本人申請、Staffログインによる確認・承認・却下、公開Webへの反映を確認する。既存の端末登録・表示バンドルを含むfixtureを用意し、本番データをテストへ流用しない。

## 14. Acceptance Criteria

詳細は `docs/acceptance-checks.json` のcheck_066〜check_095。合否の要点は次のとおり。

1. ログインなしで必須2項目から申請でき、写真・ロゴ・任意情報も正しく送信できる。
2. 未同意、不正入力、容量超過、偽装画像、他Origin、管理用フィールドの混入を拒否する。
3. 未承認の情報と画像は公開config・公開素材API・通常素材一覧に出ない。
4. 承認だけで既存形式のメンバー紹介が1件作られ、公開配信へ反映される。
5. 同時承認・承認と却下・送信再試行・保存途中の失敗で重複や部分掲載が起きない。受付結果不明の間は編集・新しいkeyの発行を禁止し、同じ送信内容だけを再送する。
6. 未ログイン・無効化済み利用者は審査・申請画像閲覧を行えない。
7. 中断/却下の画像を空マーカーに置換し、遅延保存で復活させない。期限切れ確定と回収は各50件/回を上限とし、回収完了した申請を再処理しない。確認待ちと承認済み素材を申請掃除で消さない。
8. 登録QRが正しい公開フォームを開き、320〜430pxの画面と実機2種類で操作できる。
9. 既存の手動登録・編集・表示切替・検索・削除・公開表示が維持される。
10. 所定の型・Lint・テスト・ビルド・バンドル検査が成功する。未実施の実機確認は未検証として残す。

## 15. Repair Loop

実装レビューでは、受付再開/回収の順序を強制するテスト不足と、回収検索が部分索引を使わない問題を修正した。後者は実Drizzle/libSQLのクエリで回収済み1万件を含むEXPLAINを実行し、全走査から未回収用部分索引の利用へ変わることを確認した。仕様変更はなく、既存schema/migrationは維持した。

2026-10-01のレビュー後に次を変更した（schema/migrationの変更なし）。

- 承認時に申請側の `payload` をnullにする。掲載メンバーを削除した後に、申請側へ名前・会社名などが残り続けないようにするため。
- 送信回数の上限を同一IPで60秒20回に上げる。施設のWi-Fiを共有するメンバーが受付のQRから同時に送ると、5回ではすぐ待たされるため。
- 確認待ちの件数を管理画面のベルに出し、`/admin/spotlights?tab=pending` へのリンクにする。メール・LINE・Slack通知は引き続き対象外。
- 本番で写真付きの申請が「送信できたか確認できません」になった。vinext が multipart/form-data のPOSTを Server Action の候補として扱い、既定1MBを超えると API に届く前に素の文字の413を返していた。`next.config.ts` の `experimental.serverActions.bodySizeLimit` を `6mb` にした。
- 送信を小さくするため、写真を選んだ時点で長辺1280pxまで縮め、1枚約400KBに収まるまで画質を85%から65%まで下げ、それでも大きければ寸法を640pxまで縮める。
- 承認できなかったときにスタッフへ出す文言を、本人向けの「送信結果を確認」から、画像を読めなかった・ほかの操作と重なった等のスタッフ向けの文言に分ける。


1. 対応する既存の検証コマンドまたは手動確認を実行する。
2. 失敗した出力、入力条件、ブラウザ・環境を記録する。
3. check_idから担当task_idと所有ファイルを特定する。
4. 関連ファイルだけ修正する。認証を緩めたり、テストを成功するだけの値に書き換えない。
5. 対象検証を再実行し、変更が影響する回帰確認を行う。
6. 実装が本計画と変わる場合は計画・タスク・受け入れ条件をそろえて更新する。

---

# Appendix: 既存MVP計画（今回の作成前の原文）

以下は既存機能の背景資料。今回の本人登録には上の1〜15節を適用する。旧文書の「現時点」や「未作成」は初期作成時点の記述であり、現在の実装状態を示すものではない。

# Implementation Plan: Share House Signage MVP（v2）

- v1: 2026-09-24 初版
- v2: 2026-09-24 敵対的レビュー（Gemini 3.8 Flash / GPT-6 Astra、計80件）を反映。採否は `docs/reviews/adversarial-review-2026-09-24.md`
- v2.1: 2026-09-24 仮置きの前提（表示スケジュール、権限、天気 API、音量）をユーザー指示で確定

## 0. 正典と優先順位

正典は `docs/要件定義書.md`、`docs/TECH_STACK.md`、`image/dashboard.png`、`image/UI-H.png`、`image/UI-V.png`。食い違う場合は次の順で優先する。

1. 本計画 8 節の業務規則（イベントの選び方、状態判定、動画間隔など）
2. 本計画 6 節の権限表
3. 要件定義書の記述
4. モックの配置・配色・文字組み（モック中の日付や人数などの値は例示であり、正としない）

**デザインはモックへの完全一致を目標とする**（2026-09-24 ユーザー指示）。固定日時・固定データで描画したスクリーンショットをモックと画素単位で比較し、差を詰める。

本計画と要件定義書が食い違う箇所は、要件定義書を本計画に合わせて改訂済み（21 節ポーリング間隔ほか。14 節末尾に一覧）。

## 1. Overview

シェアハウスの大型ディスプレイ（Raspberry Pi 4 接続）に、イベント・お知らせ・ハウスルール・時計・天気を表示し、指定間隔で動画を全画面再生するデジタルサイネージを作る。受付スタッフは PC ブラウザの管理画面から内容を更新する。

1. **Web（Cloudflare Workers）**: Next.js を vinext で Workers に載せた管理画面と API。データは Turso、画像・動画・表示バンドルは R2。
2. **表示ページ**: 縦型・横型の2レイアウトを持つ React 画面。管理画面のプレビューと Pi の両方で同じ部品を使う。
3. **Pi**: Python の Signage Agent が設定を同期し、世代単位でキャッシュを切り替え、表示ページを localhost で配信し、mpv で動画を再生し、表示の生存を監視する。

## 2. Goal

- **利用者**: 受付スタッフがマニュアルなしでイベントを登録し、30 秒以内にサイネージへ反映される。住人は共用部の画面で予定とお知らせを知る。
- **事業**: ネット切断・停電・再起動があっても人手なしで表示が続き、壊れても直前の正常な状態へ戻る。

## 3. Current State

- `/Users/noritakasawada/AI_P/og-app` は独立した Git リポジトリ（コミット0）。リモートは `github.com/sawanori/og-signage`（未 push）。
- 存在するのは正典の文書2点、モック画像3点、本計画書3点、レビュー記録のみ。アプリのコードと検証コマンドはない。

## 4. Scope

要件定義書 43 節「MVP」の全項目と、レビューで追加した次の項目。

- 世代単位のキャッシュ切替と直前世代への復帰（Pi）
- 表示バンドル・Agent 本体の更新と失敗時の戻し（手動実行の更新手順）
- 表示の生存監視と段階的な自動復旧
- 外付け RTC による時刻保持
- SD カード書き込みの抑制と 72 時間連続運転試験
- クラウドのバックアップと復元手順

## 5. Non-Scope

- スマートフォン・タブレット対応（管理画面は PC 幅 1280px 以上のみ）
- 要件定義書 44 節「Phase 2」の全項目
- サイネージのタッチ操作、WebSocket
- 動画のサーバー側変換
- 遠隔からの自動更新（更新は保守担当が Pi 上で手順を実行する）

## 6. Assumptions

1. **表示スケジュール**: 曜日ごとの表示時間帯。時間外は HDMI 出力を切り、動画も止める。出力を切れない場合は黒画面。日をまたぐ時間帯（22:00〜翌6:00 など）を許す。未設定の曜日は終日表示。（2026-09-24 確定）
2. **権限表**（2026-09-24 確定）:

   | 操作 | Staff | Administrator |
   |---|---|---|
   | イベント・メディア・動画設定・お知らせ・テスト表示 | ○ | ○ |
   | デザイン設定・表示スケジュール・端末・ユーザー・システム設定 | × | ○ |

3. **参加人数**: スタッフが手入力する。
4. **天気 API**: OpenWeatherMap の無料プラン（Current Weather API `/data/2.5/weather`）を使う（2026-09-24 確定）。無料枠は月 100 万回・毎分 60 回で、30 分ごとの取得（1 日 48 回）で足りる。Open-Meteo は無料枠が非商用に限られ、商用は月額 $29 からのため採らない。API キーは環境変数 `OPENWEATHER_API_KEY`（Workers の Secret）。登録時の利用規約（商用可否・出典表示の要否）は task_002 で原文を確認して `docs/spikes/workers.md` に記録し、出典表示が必要なら表示ページの天気欄の近くに小さく出す。
5. **端末トークン**: 32 バイト乱数。DB には SHA-256 のみ保存。平文は端末登録時と再発行時に Pi 用設定ファイルとして1回だけ出力する。Agent は `Authorization: Bearer` ヘッダーで送る。URL には載せない。
6. **R2 → Pi**: Worker が端末トークンを確認し、R2 の本体をストリームのまま中継する（Range 対応、メモリにためない）。R2 のアクセスキーはアプリに持たせない。task_002 で 500MB の中継を実測し、失敗したらこの前提を見直す。
7. **アップロード**: Worker 経由の R2 マルチパート（1パート 10MB）。動画は1ファイル 500MB まで、画像は 20MB まで。
8. **サムネイル・尺・コーデック情報・ハッシュ**: ブラウザで生成・取得する。ハッシュは増分計算（ファイル全体をメモリに載せない）。サーバーは先頭バイトで形式を検査し、R2 上のサイズと照合する。ハッシュの正しさは Pi が取得時に検証し、3回不一致なら隔離して管理画面に通知する。
9. **フォント**: サブセット化した WOFF2 を表示バンドルに同梱。選定は web-typography スキルに従う。
10. **QR コード**: 表示ページ内で生成。URL は http/https のみ許可。
11. **config の版**: 同一の読み取りトランザクションで組み立てた config JSON の SHA-256 を `version` とする。内容が変われば必ず版が変わり、手動で番号を上げる処理は持たない。
12. **ONLINE / OFFLINE**: `last_seen_at` から判定（5分以内で ONLINE）。これとは別に、Pi が報告する表示の状態で「表示異常」を出す。
13. **時刻**: Pi 4 には RTC がないため、電池付き外付け RTC（DS3231）を必須の部材とする。時刻が未同期のとき（RTC 故障など）は表示スケジュールによる消灯をしない。動画の間隔や再試行は OS の単調増加時計で測る。
14. **Pi OS**: Raspberry Pi OS Bookworm 64bit。GUI 起動方式（Wayland/labwc か X11）、画面回転の方法、HDMI 出力を切る方法は task_003 の結果で固定する。
15. **音声**: 動画の音量は端末ごとの設定で、初期値は 0（ミュート）。（2026-09-24 確定）
16. **ストレージ**: 高耐久 microSD（または USB SSD）。容量 32GB 以上。
17. **パッケージマネージャ**: npm。版は task_002 で固定し、`package-lock.json` をコミットする。
18. **タイムゾーン**: 判定はすべて `Asia/Tokyo`、保存は UNIX 秒。
19. **端末台数**: MVP は1台運用。データ構造は複数台に対応する。

## 7. Architecture Impact

### Web

- Next.js（App Router）+ React + TypeScript + Tailwind CSS + shadcn/ui + Lucide + React Hook Form + Zod + date-fns。vinext で Workers にデプロイ。
- Turso は `@libsql/client` の Web 版で接続する。config の組み立ては読み取りトランザクション内で行う。
- Cron Trigger: 天気取得（30 分ごと）、R2 削除予約の実行、未完了アップロードの掃除、古い `device_logs` の削除（毎日）。`wrangler.jsonc` の `main` を `./worker/index.ts`（独自エントリ）にし、vinext の `fetch` に `scheduled` を足して公開する（task_002 で確認）。
- 大きなファイルの中継（端末向けの媒体・バンドル、管理画面の動画）は `worker/index.ts` で vinext より前に処理し、R2 の本文をそのまま返す。vinext の Route Handler を通すと本文が JS で包み直され、500MB で CPU 17〜20 秒を使うため（task_002 実測。独自エントリでは CPU 0〜1ms）。アップロードのパート受信は Route Handler でよい（1 パート CPU 16〜44ms）。
- 認証: Auth.js（`next-auth@5.0.0-beta.32`、Credentials、JWT）。JWT に `userId` と `sessionVersion` を載せ、保護操作ごとに DB の `is_active`・`role`・`session_version` と照合する（task_002 で Route Handler・Server Action とも動作確認済み）。パスワードは Web Crypto の PBKDF2（SHA-256、100,000 回。Workers は 100,000 回を超える反復に対応しない）。
- CSRF: Cookie は `SameSite=Lax; Secure; HttpOnly`。更新系の Route Handler は `proxy.ts`（Next.js 16 での `middleware.ts` の名前）で `Origin` が自サイトでなければ 403（`Origin` なしも 403）。vinext は Route Handler の Origin を検査しない。Server Actions は vinext 本体が別 Origin を 403 にする（task_002 で確認）。
- レート制限: ログインは IP とメールアドレス単位（Workers の Rate Limiting binding）。binding はマシンごとの概算で、接続が分かれると制限がかからないことがある（task_002）。同じメールアドレスへの連続失敗は DB の失敗回数でも止める。

### 表示ページ

- 部品は `components/signage/`。データは Zod で定義した `SignageConfig` 型（`lib/config-schema.ts`）だけを受け取る。画像の URL は外から渡す解決関数で決める（クラウドは管理用素材 API、Pi は `/local/media/<sha256>`）。
- 時刻による絞り込み（今日のイベント、Upcoming、お知らせの時間帯、表示スケジュール）は表示側で `lib/display-rules.ts` を使って行う。Pi と管理画面プレビューで同じ関数を使う。
- Pi 用バンドルは Vite で静的ビルドし、ハッシュ付きの不変な ID で R2 に公開する。

### Pi

```text
/opt/sharehouse-signage/
    releases/<agentVersion>/   Agent 本体（版ごと）
    current -> releases/<agentVersion>
/var/lib/sharehouse-signage/
    media/<sha256>             画像・動画（内容アドレス。世代間で共有）
    bundles/<bundleId>/        表示バンドル（版ごと）
    generations/<version>/     config.json と manifest.json（必要な media と bundle の一覧）
    current -> generations/<version>
    previous -> generations/<version>
    state/                     適用履歴、隔離した媒体、未送信ログ（上限つき）
```

- **同期**: 10 秒ごとに config を取得。版が変わったら新しい世代を作り、必要なファイルを全部そろえて検証してから `current` を原子的に付け替え、旧 `current` を `previous` にする。空き容量が足りなければ更新を保留し、現行世代で表示を続ける。
- **スレッド**: 同期、ダウンロード、Heartbeat、ローカルサーバー、再生、監視を分ける。ダウンロード中も Heartbeat と設定反映は止めない。
- **ローカルサーバー**: `ThreadingHTTPServer` で `127.0.0.1` のみ待ち受け。表示ページへの指示は SSE（`/local/events`）。表示ページは 5 秒ごとに `/local/ack` へ生存を返す。
- **再生**: 状態機械（`display → fading_out → playing → fading_in → display`）。各遷移に ID と期限を持つ。mpv は `--input-ipc-server` で再生位置を監視し、10 秒進まない・尺＋10 秒を超える・起動失敗のいずれかで強制終了して表示へ戻す。
- **監視**: 表示の生存応答が 60 秒ない → Chromium 再起動。それでも戻らない → Agent が自身を再起動（systemd）。Chromium は毎日 4:00（表示時間外があればその中）に再起動する。
- **書き込み抑制**: Chromium のプロファイルと一時領域は tmpfs。journald は揮発メモリに上限つきで保存。Agent のログはサイズ上限つき。
- **更新**: Agent 本体とバンドルは版ごとのディレクトリに置き、切替後の生存確認に失敗したら直前の版へ戻す。

## 8. UI Plan と業務規則

### 8.1 業務規則（表示と管理画面で共通。`lib/display-rules.ts`）

- **対象**: `status = published` のイベントだけを表示する。下書きは管理画面にのみ出る。
- **終了日時なし**: その日の 23:59:59 に終わるものとして扱う。
- **状態**: 開始 30 分前から開始まで STARTING SOON、開始から終了まで NOW HAPPENING、それ以外で今日のものは TODAY。
- **大きな枠（スライドショー）**: 終わっていない公開イベントをすべて、開催中を先頭に、残りは開始順で 15 秒ごとに切り替えて出す（サイネージはタッチ操作ができず、各イベントの詳細はここでしか見られないため。2026-09-25 ユーザー指示）。QR は右下で、何枚目かを示す点の並びの真上。イベントが 1 件も無ければハウスのキャッチコピーを出す。
- **今日の主イベント**: 開催中のものを優先し、なければ今日これから始まるもの。同じ条件なら開始が早い順、次に作成が早い順。管理画面の「今日のイベント」に使う。
- **Upcoming**: 終わっていない公開イベントを、今日の分（開催中と今日の主イベントを含む）から開始順に、横型は最大 5 件・縦型は最大 3 件（2026-09-27 ユーザー指示で今日の主イベントも含める）。
- **今週の予定**: 月曜始まりの 7 日間。
- **お知らせ**: `enabled` かつ表示時間帯内のもの。複数ある場合は更新が新しい1件。
- **動画間隔**: 前の動画の終了から次の動画の開始までの待ち時間。1回に1本。起動直後と表示時間帯の開始直後は、その時点から間隔を数える。順番再生の位置は Pi に保存し、再起動後も続きから再生する。
- **テスト表示**: 管理画面から押すと、対象端末が次の同期で次の動画を1本すぐ再生する（1回限り）。

### 8.2 管理画面（PC のみ、最小幅 1280px）

| 画面 | パス | 権限 | 状態 |
|---|---|---|---|
| ログイン | `/login` | 全員 | 失敗時は「メールアドレスかパスワードが違います」。制限中は「しばらくしてからお試しください」 |
| ダッシュボード | `/admin` | Staff 以上 | `dashboard.png` の配置。端末の実際の表示状態・適用済みの版・次回の動画予定は Heartbeat の値を出し、観測時刻を添える。空状態あり |
| イベント | `/admin/events`、`/new`、`/[id]` | Staff 以上 | リスト / カレンダー。公開・下書き。競合時は入力を保ったまま「他の人が先に更新しました」 |
| 動画・メディア | `/admin/media`、`/admin/videos` | Staff 以上 | 進捗、再生条件外の動画は追加不可と理由表示、Pi で再生に失敗した動画の表示、使用中は削除不可 |
| お知らせ | `/admin/notices` | Staff 以上 | 100 文字カウンタ、表示時間帯 |
| デザイン設定 | `/admin/design` | Administrator | ハウス名、ロゴ、キャッチコピー、フッター画像、ハウスルール、天気地域、カテゴリ色 |
| 表示スケジュール | `/admin/schedule` | Administrator | 曜日ごとの時間帯 |
| 端末 | `/admin/devices` | Administrator | ONLINE/OFFLINE/表示異常、最終通信、向き、版、空き容量、時刻同期、直近ログ、設定ファイル取得、トークン再発行、音量 |
| 端末プレビュー | `/admin/devices/[id]/preview` | Staff 以上 | 管理セッションで認証。その端末の向きと config で表示部品を描画 |
| Web 公開の表示 | `/signage`（`?device=`・`?layout=`） | ログイン不要 | 2026-09-25 ユーザー指示で追加。Pi と同じ表示部品を全画面で描き、30 秒ごとにデータを取り直す。公開するのは表示に使う項目と、表示中の画像だけ（`lib/public-signage.ts`、`worker/public-signage-relay.ts`）。動画は再生しない。検索エンジンには載せない |
| 利用ガイド | `/admin/guide` | Staff 以上 | 静的 |
| システム設定 | `/admin/settings` | Administrator | ユーザーの追加・役割変更・無効化。最後の Administrator は無効化不可 |

- 文言は要件定義書 28 節に従う。トークン・技術用語・エラー原文を出さない。

### 8.3 表示ページ

- 固定キャンバス（1080×1920 / 1920×1080）を画面に合わせて拡大縮小。
- 状態: TODAY、STARTING SOON、NOW HAPPENING、イベントなし、表示時間外（出力停止または黒）、フェード、時刻未同期（画面隅に小さな印）。
- 文字あふれ: タイトル 2 行、説明 3 行、お知らせ本文 2 行で省略記号。
- 画像なし: カテゴリ色の背景。
- 天気: `fetchedAt` が 3 時間より古い、または時刻未同期なら天気欄を出さない。

## 9. API Plan

すべて JSON。入力は Zod で検証。エラーは `{ error: { code, message } }`、`message` は利用者向けの日本語。

### 管理用（管理セッション必須、更新系は Origin 検査）

| メソッド・パス | 役割 | 権限 |
|---|---|---|
| `GET/POST /api/events`、`GET/PUT/DELETE /api/events/[id]` | イベント CRUD。PUT は `revision` 必須、不一致は 409 | Staff 以上 |
| `GET /api/media`、`DELETE /api/media/[id]` | 一覧・削除予約。参照中は 409 | Staff 以上 |
| `GET /api/media/[id]/file`、`GET /api/media/[id]/thumbnail` | 非公開 R2 の素材を管理画面へ中継。`X-Content-Type-Options: nosniff`、MIME は検査済みの値 | Staff 以上 |
| `POST /api/media/uploads` | 開始。`uploads` に記録し `{ uploadId }` を返す。キーはサーバーが決める | Staff 以上 |
| `PUT /api/media/uploads/[uploadId]/parts/[n]` | パート送信。1 パート目で形式を検査 | 開始したユーザー |
| `POST /api/media/uploads/[uploadId]/complete` | 完了。冪等（再送しても同じ media を返す） | 開始したユーザー |
| `DELETE /api/media/uploads/[uploadId]` | 中断 | 開始したユーザー |

お知らせ・デザイン設定・ハウスルール・カテゴリ・表示スケジュール・動画設定・端末・ユーザーは Server Actions で扱う。Route Handler と Server Action は同じ `lib/services/*` を呼ぶ。

### 端末用（`Authorization: Bearer <token>`、セッション不要）

| メソッド・パス | 役割 |
|---|---|
| `GET /api/device/config` | 要件定義書 39 節の形。`schemaVersion`、`version`（SHA-256）、`events`（前日〜30 日後の公開分）、`notices`、`house`、`schedule`、`weather`、`playlist`（`mediaId`、`sha256`、`size`、`durationSeconds`）、`displayBundle`（`id`、`sha256`、`size`）、`device`（向き、音量）、`commands`（テスト表示）、`video`（`enabled`、`intervalMinutes`、`mode`）。画像参照は `{ mediaId, sha256, size }` のオブジェクトで `house.logo`・`house.footerImage`・`events[].image`・`notices[].image` に置く。`schedule[].weekday` は 0=日曜〜6=土曜。正確な型は `lib/config-schema.ts` を正とする。`If-None-Match` 一致で 304 |
| `GET /api/device/media/[mediaId]` | R2 の中継。Range 対応。その端末の現行 config に含まれるものだけ |
| `GET /api/device/bundles/[bundleId]` | 表示バンドル（zip）の中継 |
| `POST /api/device/heartbeat` | `{ agentVersion, bundleId, appliedVersion, pendingVersion, mode, displayHealthy, nextVideoAt, lastVideoFinishedAt, timeSynced, diskFreeBytes, cpuTempC, memAvailableBytes }` |
| `POST /api/device/logs` | 最大 50 件。端末ごとに1日 5,000 件まで |
| `POST /api/device/media-failures` | 取得や再生に失敗した媒体を報告（管理画面に表示） |

- 認証失敗は 401。トークンはログに出さない。

## 10. Database Plan

要件定義書 34 節のテーブルを Drizzle で定義し、次の変更を加える。

- `users`: `is_active`、`session_version` を追加。
- `devices`: `token` → `token_hash`（UNIQUE）。`status`・`config_version` は持たない。`volume`、`test_play_requested_at`、Heartbeat の最新値（9 節の各項目）、`last_seen_at` を持つ。
- `events`: 要件どおりの追加列と `revision`。`status` は `published | draft`。インデックス `(status, start_at)`。
- `media`: `thumbnail_r2_key`、`sha256`、`codec_info`（JSON）、`playable`（task_003 の条件を満たすか）、`state`（`active | deleting`）、`delete_after`。
- `uploads`: `id, user_id, kind, r2_key, r2_upload_id, declared_size, state(uploading|completed|aborted), media_id, created_at`。
- `media_failures`: `device_id, media_id, reason, count, last_at`。
- `notices`・`house_settings`・`playlists`・`video_playback_settings`: `revision` を追加。
- `display_schedules`: `weekday, start_time, end_time, enabled`（日またぎを許す）。
- `weather_cache`（1 行）、`display_bundles`（`id, sha256, size, r2_key, schema_version, published_at, is_current`）。
- 画像参照（`events.image_media_id`、`notices.image_media_id`、`house_settings.logo_media_id`、`house_settings.footer_image_media_id`）と `playlist_items.media_id` はすべて外部キー `ON DELETE RESTRICT`。
- 削除は「参照がないことを確認 → `state = deleting`（新規参照を禁止）→ 7 日後に Cron が R2 から削除し行を消す」。R2 削除の失敗は次回に再試行。
- `device_logs`: インデックス `(device_id, created_at)`、30 日で削除。
- 初期データ: カテゴリ5件、`house_settings`、プレイリスト1件。管理者は `scripts/create-admin.ts` で作る。

## 11. File-by-File Plan

| ファイル | 作成/変更 | 目的 | リスク |
|---|---|---|---|
| `package.json`、`tsconfig.json`、`vite.config.ts`、`wrangler.jsonc`、`drizzle.config.ts`、`.github/workflows/ci.yml` | 作成 | 基盤・CI | 中 |
| `db/schema.ts`、`db/index.ts`、`db/migrations/**`、`db/seed.ts` | 作成 | スキーマ | 中 |
| `lib/config-schema.ts`、`lib/display-rules.ts`、`lib/dates.ts` | 作成 | config の型と業務規則 | 高 |
| `lib/auth.ts`、`lib/password.ts`、`lib/csrf.ts`、`lib/rate-limit.ts`、`proxy.ts` | 作成 | 認証・権限・CSRF | 高 |
| `lib/r2.ts`、`lib/services/*.ts`、`lib/validators.ts`、`lib/device-auth.ts`、`lib/config-builder.ts`、`lib/weather.ts`、`lib/file-sniff.ts` | 作成 | サービス層 | 高 |
| `app/api/**/route.ts` | 作成 | 9 節の API | 高 |
| `app/login/**`、`app/admin/**` | 作成 | 管理画面 | 中 |
| `components/signage/**`、`components/admin/**`、`components/ui/**` | 作成 | 部品 | 中〜高 |
| `display/**` | 作成 | Pi 用バンドル | 高 |
| `worker/index.ts`、`worker/scheduled.ts` | 作成 | Worker の入口（vinext・大きなファイルの中継・Cron） | 中 |
| `scripts/create-admin.ts`、`scripts/publish-display-bundle.ts`、`scripts/backup-db.sh` | 作成 | 運用 | 中 |
| `raspberry-pi/agent/*.py`、`raspberry-pi/tests/*.py` | 作成 | Agent | 高 |
| `raspberry-pi/systemd/*`、`raspberry-pi/install.sh`、`raspberry-pi/update.sh`、`raspberry-pi/os/*` | 作成 | 導入・更新・OS 設定 | 高 |
| `docs/spikes/*.md`、`docs/runbook.md`、`docs/acceptance-report.md` | 作成 | 検証・運用記録 | 低 |

## 12. Implementation Order

| 段階 | タスク | 内容 |
|---|---|---|
| Phase 0 | task_001〜003 | 雛形と CI、Workers 検証、Pi 実機検証。**002 と 003 は合格条件を満たすまで Phase 1 以降に進まない。** 不合格項目は代替案を試し、それでも駄目なら計画を改訂してユーザー判断を仰ぐ |
| Phase 1 | task_004〜013 | スキーマ、config の型と業務規則、認証、各サービスと API、端末 API、天気と Cron |
| Phase 2 | task_014a・014b・015〜019 | 表示ページ（固定データ版 → config 接続）、管理画面 |
| Phase 3 | task_020〜022 | Agent（同期・世代・ダウンロード）、表示と再生と監視、OS 設定と systemd |
| Phase 4 | task_023〜025 | 実機の総合確認、72 時間連続運転、本番デプロイと更新・復元手順 |

並行できる組: 002 と 003。014a は 005 完了後に Phase 1 と並行できる。

## 13. Verification Commands

**現時点でリポジトリに存在するコマンドはない。** task_001 と task_020 で作成する。作成前に実行しない。

- `npm run typecheck`、`npm run lint`、`npm test`、`npm run build`、`npm run build:display`
- `npm run db:generate`、`npm run db:migrate`
- `python3 -m pytest raspberry-pi/tests`

## 14. Acceptance Criteria

`docs/acceptance-checks.json` を正とする。要約：

1. 要件定義書 45 節の完成条件 1〜16 を実機で満たす。
2. すべての検証コマンドが CI とローカルで成功する。
3. 停電・ネット切断・更新途中の電源断のどれが起きても、直前の正常な表示に戻る。
4. 無効化・降格したユーザーの旧セッション、別 Origin からの更新、偽装ファイルが拒否される。
5. 72 時間の連続運転で、メモリ・書き込み量・温度・再生の遅れが 13 節の基準内。

要件定義書に反映した変更: 21 節（ポーリング 10 秒）、25 節・27 節・38 節（端末トークンはヘッダー、URL に載せない）、19 節・40 節（プレビューは管理セッションの経路）、3.5 節（外付け RTC）、11 節（動画間隔の定義）、15 節（動画の上限 500MB と再生条件）。

### 数値基準（task_024）

- Chromium と Agent の常駐メモリ増加が 72 時間で 20% 以内
- 1 日の SD 書き込み量が 2GB 以内（`/proc/diskstats` で計測）
- SoC 温度 80℃ 未満
- 動画開始の遅れが設定時刻から 30 秒以内

## 15. Repair Loop

1. 検証コマンドを実行する。
2. エラー出力を記録する。
3. エラーを task_id に対応づける（11 節の表でファイルから引く）。
4. そのタスクのファイルだけを修正する。
5. 検証コマンドを再実行する。
6. 実装が計画と食い違った場合は、本計画と `docs/task-list.json` を更新してから次へ進む。
