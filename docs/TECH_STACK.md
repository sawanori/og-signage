# TECH_STACK.md
# シェアハウス向けデジタルサイネージ 技術スタック定義書

更新日: 2026-09-24

---

## 1. システム概要

シェアハウス内の大型ディスプレイに、イベント情報・お知らせ・画像・定期動画を表示するデジタルサイネージシステム。

主な要件:

- 受付スタッフが直感的に操作できるWeb管理画面
- イベントの追加・編集・削除
- イベント画像・動画のアップロード
- 指定間隔（初期値10分）で動画を全画面再生
- 動画終了後にイベント画面へ自動復帰
- Raspberry Pi 4 / 4GB を表示端末として使用
- オフライン時も直近データと動画で表示継続
- CloudflareへWebアプリ/APIをデプロイ
- SQLはTurso
- オブジェクトストレージはCloudflare R2
- Electronは使用しない

---

# 2. 全体アーキテクチャ

```text
[受付スタッフ]
       |
       v
+-----------------------------+
| Web管理画面                 |
| Next.js / React / TypeScript|
+-------------+---------------+
              |
              v
+-----------------------------+
| Cloudflare Workers          |
| API / SSR / Server Actions  |
+-------------+---------------+
              |
       +------+------+
       |             |
       v             v
+------------+   +------------+
| Turso      |   | R2         |
| libSQL/SQL |   | Images     |
| Metadata   |   | Videos     |
+------------+   +------------+

             Internet
                |
                v

+--------------------------------------+
| Raspberry Pi 4 / 4GB                 |
|                                      |
| Chromium Kiosk -> localhost UI       |
| Python Agent    -> Sync / Heartbeat   |
| mpv             -> Fullscreen Video   |
| Local Cache     -> Offline Operation  |
+------------------+-------------------+
                   |
                   v
          Large Signage Display
```

---

# 3. フロントエンド

## Framework

- Next.js
- React
- TypeScript

## UI

- Tailwind CSS
- shadcn/ui
- Lucide Icons

## Form

- React Hook Form
- Zod

## Date / Time

- date-fns
- タイムゾーン: `Asia/Tokyo`

## 主な画面

```text
/login
/admin
/admin/events
/admin/events/new
/admin/events/[id]
/admin/media
/admin/videos
/admin/devices
/admin/notices
/admin/design
/admin/schedule
/admin/guide
/admin/settings
/admin/devices/[id]/preview   # 管理画面プレビュー（Pi は localhost を表示）
```

## UI設計方針

受付スタッフ向けのため、技術用語を極力表示しない。

表示する言葉の例:

- イベントを追加
- イベントを編集
- 動画を変更
- 10分ごと
- 表示する
- 公開する
- 保存する
- 削除する

表示しない言葉の例:

- event_id
- playlist_id
- device token
- R2 key
- API endpoint
- cron
- SQL

---

# 4. バックエンド

## Runtime

- Cloudflare Workers

## Application Backend

- Next.js Route Handlers
- Server Actions

別途NestJS / Expressサーバーは用意しない。

## API方式

RESTベース。

主なAPI:

```text
GET    /api/events
POST   /api/events
GET    /api/events/[id]
PUT    /api/events/[id]
DELETE /api/events/[id]

GET    /api/media
POST   /api/media/upload
DELETE /api/media/[id]

GET    /api/device/config          # Authorization: Bearer <deviceToken>。イベント・お知らせ・ハウス設定・天気・プレイリスト・表示バンドルを含む
GET    /api/device/media/[mediaId]
GET    /api/device/bundles/[bundleId]
POST   /api/device/heartbeat
POST   /api/device/logs
POST   /api/device/media-failures
```

---

# 5. Cloudflareデプロイ

## Hosting

- Cloudflare Workers

## Next.js実行

- vinext

Cloudflare Workers上でNext.jsアプリを実行する。

## CLI

- Wrangler

## 主な設定ファイル

```text
wrangler.jsonc
package.json
next.config.*
drizzle.config.ts
```

## R2接続

R2 API Keyをアプリへ直接埋め込まず、Cloudflare WorkersのR2 Bindingを使用する。

例:

```jsonc
{
  "r2_buckets": [
    {
      "binding": "MEDIA_BUCKET",
      "bucket_name": "sharehouse-signage"
    }
  ]
}
```

---

# 6. Database

## Database Service

- Turso

## Database Engine

- SQLite互換
- libSQL

## ORM

- Drizzle ORM

## Driver

- `@libsql/client`

## Migration

- Drizzle Kit

## 接続環境変数

```env
TURSO_DATABASE_URL=
TURSO_AUTH_TOKEN=
```

---

# 7. 主要DBテーブル

```text
users
events
event_categories
media
devices
playlists
playlist_items
video_playback_settings
device_logs
notices
house_settings
house_rules
```

## users

管理画面ユーザー。

## events

イベント情報。

## media

画像・動画のメタデータ。

実ファイルはR2へ保存する。

## devices

Raspberry Pi端末情報。

## playlists

動画プレイリスト。

## playlist_items

プレイリスト内の動画と再生順。

## video_playback_settings

端末ごとの定期動画設定。

## device_logs

Raspberry Pi側の状態・エラー・再生履歴。

---

# 8. Storage

## Service

- Cloudflare R2

## Bucket

例:

```text
sharehouse-signage
```

## オブジェクト構成

```text
images/
videos/
thumbnails/
```

例:

```text
images/01ABCDEF.webp
videos/01XYZ123.mp4
thumbnails/01XYZ123.webp
```

## DBに保存するもの

R2ファイルそのものではなく、以下のメタデータをTursoへ保存。

```text
id
name
type
r2_key
mime_type
width
height
duration_seconds
file_size
created_at
```

---

# 9. 認証

## 管理画面

- Auth.js

初期実装では管理者・受付スタッフのみ。

役割:

```text
admin
staff
```

## サイネージ端末

サイネージ画面には一般ユーザーのログインは不要。

端末固有の推測困難なDevice Tokenを使用し、`Authorization: Bearer` ヘッダーで送る（URL には載せない）。

---

# 10. Raspberry Pi

## Hardware

- Raspberry Pi 4
- RAM 4GB
- 外付け RTC（DS3231 等、必須）
- 高耐久 microSD または USB SSD

## OS

- Raspberry Pi OS 64bit

## 表示

- Chromium
- Kiosk Mode

## 制御Agent

- Python 3

## ローカル表示サーバー

- Python Agent に同梱
- 表示ページのビルド済み静的ファイルとキャッシュデータを localhost で配信
- Chromium は `http://localhost:8080/` を開く（クラウドを直接開かない）

## 動画再生

- mpv

## 常駐管理

- systemd

Electronは使用しない。

---

# 11. Raspberry Pi側ディレクトリ例

```text
/opt/sharehouse-signage/
    agent/
        main.py
        api.py
        sync.py
        player.py
        downloader.py
        config.py

/var/lib/sharehouse-signage/
    config.json
    events.json
    playlist.json
    videos/
    images/
    display/      # 表示ページのビルド済み静的ファイル
```

---

# 12. Signage Agent

Python Agentの責務:

1. Cloudflare APIから端末設定取得
2. config version確認
3. イベントデータ同期
4. 動画プレイリスト同期
5. 新規動画をR2から取得
6. ローカルキャッシュ保存
7. mpvで動画を起動
8. 動画終了を検知
9. Chromium画面へ復帰
9-2. ローカル表示サーバーで表示ページとキャッシュを配信
10. Heartbeat送信
11. Device Log送信
12. ネットワーク復旧時の再同期

---

# 13. 動画再生設計

通常表示:

```text
Chromium
↓
イベントサイネージ
```

指定間隔経過:

```text
Chromium
↓
mpv Fullscreen
↓
動画再生
↓
mpv終了
↓
Chromiumへ復帰
```

標準設定:

```text
enabled: true
intervalMinutes: 10
playbackMode: sequence
fullscreen: true
fadeDurationMs: 500
```

再生モード:

```text
sequence
random
```

---

# 14. 動画仕様

推奨:

```text
Container : MP4
Codec     : H.264
FPS       : 30fps
```

横型:

```text
1920 x 1080
```

縦型:

```text
1080 x 1920
```

基本方針:

- 4K動画を標準にしない
- PiのHDMI出力もまず1080pで運用
- 大型4Kディスプレイ側でアップスケール
- R2から毎回ストリーミングせずPiへキャッシュ

---

# 15. 動画同期

```text
R2
 |
 v
Pi Agent
 |
 v
Local Storage
 |
 v
mpv
```

動画が変更された場合のみ再ダウンロード。

同一動画を10分ごとにR2から取得しない。

---

# 16. Offline対応

Piに以下を保存:

```text
config.json
events.json
playlist.json
videos/
images/
```

インターネット接続が切れても:

- ネット切断中に Pi が再起動しても、localhost の表示ページで表示を再開
- 現在のイベント表示を継続
- キャッシュ済み動画を再生
- ネット復旧後に自動同期

---

# 17. Device Sync

MVPではWebSocketを使用しない。

## Polling

```text
10秒ごと
```

API:

```text
GET /api/device/config
```

Config Version方式で更新判定。

例:

```json
{
  "version": 24
}
```

Piローカル:

```text
version = 23
```

なら同期。

同一versionなら何もしない。

---

# 18. Heartbeat

Piから定期送信。

```text
60秒ごと
```

Endpoint:

```text
POST /api/device/heartbeat
```

5分以上Heartbeatが来ない場合:

```text
OFFLINE
```

と管理画面に表示。

---

# 19. Logging

## Cloud

- Cloudflare Workers Logs

## Application

`device_logs` テーブル。

イベント例:

```text
DEVICE_BOOT
DEVICE_ONLINE
DEVICE_OFFLINE
CONFIG_UPDATED
DOWNLOAD_STARTED
DOWNLOAD_COMPLETED
DOWNLOAD_FAILED
VIDEO_STARTED
VIDEO_FINISHED
VIDEO_FAILED
```

---

# 20. Package構成

## Frontend / Backend

```text
next
react
react-dom
typescript
tailwindcss
zod
react-hook-form
@hookform/resolvers
lucide-react
date-fns
```

## Database

```text
drizzle-orm
drizzle-kit
@libsql/client
```

## Auth

```text
next-auth
```

## Weather

- OpenWeatherMap 無料プラン（Current Weather API）
- Worker の Cron で30分ごとに取得・キャッシュし config API に含める
- API キーは `OPENWEATHER_API_KEY`（Workers Secret）

## Deployment

```text
wrangler
vinext
```

---

# 21. 環境変数

```env
TURSO_DATABASE_URL=
TURSO_AUTH_TOKEN=

AUTH_SECRET=
APP_URL=

DEVICE_API_SECRET=
OPENWEATHER_API_KEY=
```

R2についてはWorkers Bindingを優先し、アクセスキーをアプリ環境変数として持たせない。

---

# 22. 推奨プロジェクト構成

```text
sharehouse-signage/

├── app/
│   ├── login/
│   ├── admin/
│   │   ├── page.tsx
│   │   ├── events/
│   │   ├── media/
│   │   ├── videos/
│   │   ├── devices/
│   │   └── settings/
│   │
│   ├── admin/devices/[id]/preview/
│   │   └── page.tsx
│   │
│   └── api/
│       ├── events/
│       ├── media/
│       └── device/
│
├── components/
│   ├── admin/
│   ├── signage/
│   └── ui/
│
├── db/
│   ├── index.ts
│   ├── schema.ts
│   └── migrations/
│
├── lib/
│   ├── auth.ts
│   ├── turso.ts
│   ├── r2.ts
│   ├── dates.ts
│   └── validators.ts
│
├── raspberry-pi/
│   ├── agent/
│   │   ├── main.py
│   │   ├── api.py
│   │   ├── sync.py
│   │   ├── player.py
│   │   └── downloader.py
│   │
│   └── systemd/
│       ├── signage-agent.service
│       └── chromium-kiosk.service
│
├── drizzle.config.ts
├── wrangler.jsonc
├── package.json
└── README.md
```

---

# 23. 技術ごとの責務

| 技術 | 責務 |
|---|---|
| Next.js | Webアプリ / 管理画面 / Signage UI |
| React | UI |
| TypeScript | Webアプリ言語 |
| Tailwind CSS | Styling |
| shadcn/ui | 管理画面UI |
| Cloudflare Workers | Hosting / Backend runtime |
| vinext | Next.jsをWorkers上で実行 |
| Turso | SQL Database |
| libSQL | SQLite互換DB engine |
| Drizzle ORM | DB Access / Schema / Migration |
| Cloudflare R2 | Image / Video Storage |
| Auth.js | 管理者・スタッフ認証 |
| Chromium | 通常サイネージ表示 |
| Python | Raspberry Pi制御Agent |
| mpv | 全画面動画再生 |
| systemd | Piサービス自動起動・復旧 |

---

# 24. 採用しない技術

## Electron

採用しない。

理由:

- Raspberry Pi 4上で以前動画再生がカクついた実績がある
- UIと動画デコードを同じランタイムへ集約しない
- Chromiumとmpvへ責務分離した方が安定しやすい

## Supabase

採用しない。

今回の指定:

- SQL: Turso
- Storage: R2

へ統一する。

## 別Backend Server

NestJS / Express等はMVPでは採用しない。

Cloudflare Workers + Next.js backendで完結する。

---

# 25. 技術選定の最終形

```text
Frontend
├─ Next.js
├─ React
├─ TypeScript
├─ Tailwind CSS
├─ shadcn/ui
├─ React Hook Form
└─ Zod

Backend
├─ Cloudflare Workers
├─ Next.js Route Handlers
├─ Server Actions
└─ vinext

Database
├─ Turso
├─ libSQL / SQLite
├─ Drizzle ORM
└─ Drizzle Kit

Storage
└─ Cloudflare R2

Authentication
└─ Auth.js

Raspberry Pi
├─ Raspberry Pi OS 64bit
├─ Chromium Kiosk
├─ Python Agent
├─ mpv
├─ Local Cache
└─ systemd

Media
├─ MP4
├─ H.264
├─ 1080p
└─ 30fps
```

---

# 26. MVP技術目標

以下を達成できれば技術的なMVP完了とする。

- Cloudflare Workers上でWeb管理画面が動作
- TursoへのCRUDが正常動作
- R2への画像・動画アップロードが正常動作
- Raspberry PiがDevice Configを取得
- Chromium Kioskでサイネージ表示
- PiがR2動画をローカルキャッシュ
- 指定間隔でmpvが全画面動画再生
- 動画終了後にWeb UIへ復帰
- Pi再起動後にsystemdで自動復旧
- オフライン時もキャッシュ済みデータで動作
- HeartbeatでONLINE / OFFLINE確認可能

---

# 27. 開発方針

優先順位:

```text
1. 安定性
2. 受付スタッフの操作性
3. 自動復旧
4. オフライン耐性
5. メンテナンス性
6. 高度な演出
```

Raspberry Pi側では複雑なWeb処理や動画処理を極力行わず、

```text
Chromium = Web UI
Python   = Device Control
mpv      = Video
```

の3つに責務を分離する。

これを本システムの基本技術方針とする。
