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
- **今日の主イベント**: 開催中のものを優先し、なければ今日これから始まるもの。同じ条件なら開始が早い順、次に作成が早い順。管理画面の「今日のイベント」と、Upcoming から外すイベントに使う。
- **Upcoming**: 今日の主イベントを除く、終わっていない公開イベント（今日のうち主イベントより後のものを含む）を開始順に、横型は最大 4 件・縦型は最大 3 件。今日のイベントが無い日は、次のイベント（明日など）が先頭になる。
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
