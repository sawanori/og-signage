# 運用手順（保守担当向け）

受付スタッフ向けの操作説明ではない。本番環境（Cloudflare Workers / R2 / Turso）を
デプロイ・監視・バックアップ・復元できる保守担当者を対象にする。

コマンドはすべてこのリポジトリのルート（`og-app/`）で実行する前提。`npx wrangler ...` と
`turso ...` を使うので、事前に以下を済ませておくこと。

- `npx wrangler login`（Cloudflare アカウントで認証）
- `turso auth login`（Turso アカウントで認証）

作成日: 2026-09-25（task_025）。

---

## a. 構成と各資源の名前

| 資源 | 名前 | 備考 |
|---|---|---|
| Worker | `sharehouse-signage` | URL `https://sharehouse-signage.snp-inc-info.workers.dev`（workers.dev、独自ドメインなし） |
| R2 バケット | `sharehouse-signage` | ロケーション APAC。バインディング名 `MEDIA_BUCKET`（`wrangler.jsonc`）。媒体ファイルと表示バンドルの実体、`backups/` にこのリポジトリの DB バックアップを置く |
| Turso DB | `og-signage` | グループ `default`（aws-ap-northeast-1）。URL 形式 `libsql://og-signage-sawanori.aws-ap-northeast-1.turso.io` |
| Cron Trigger | `*/30 * * * *`（天気の取得） / `0 19 * * *`（UTC 19:00 = 日本時間 4:00 の掃除） | `wrangler.jsonc` の `triggers.crons`。ハンドラは `worker/index.ts` の `scheduled` → `worker/scheduled.ts` |
| Rate Limiting binding | `LOGIN_RATE_LIMITER`（namespace_id `4301`） | ログインの IP / メールアドレス単位の緩い制限。厳密な回数制限ではない（`docs/spikes/workers.md` 7 節） |
| Secret（Workers） | `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` / `AUTH_SECRET` / `OPENWEATHER_API_KEY` | `npx wrangler secret list --name sharehouse-signage` で名前だけ確認できる（値は表示されない）。値はこの文書に書かない |
| Pi（表示端末） | — | 導入・更新・交換は `raspberry-pi/README.md` を参照（本書の i 節） |

**他人の別件資源（触ってはいけない）**: 同じ Cloudflare / Turso アカウントに、本アプリと無関係な
R2 バケット `weworksignage` と Turso DB `non-turn-signage` が存在する。名前が似ていて `wrangler r2
bucket list` や `turso db list` の一覧に混ざって出てくるので、コマンドを打つ前に対象名を
指差し確認すること（k 節に詳細）。

---

## b. 初回構築手順（今回メインが実施した順序）

新しい環境を一から作り直す場合、または参考として実施順序を残す。

1. **Turso DB を作る**

   ```sh
   turso db create og-signage --group default
   ```

2. **マイグレーションを流す**（`TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` を環境変数で渡す）

   ```sh
   turso db show og-signage --url
   turso db tokens create og-signage
   TURSO_DATABASE_URL=<上で得た URL> TURSO_AUTH_TOKEN=<上で得たトークン> npm run db:migrate
   ```

3. **初期データを入れる**

   ```sh
   TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... npm run db:seed
   ```

4. **管理者を作る**（パスワードは 12 文字以上。`scripts/create-admin.ts` が検査する）

   ```sh
   TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... \
     npm run admin:create -- --email <メール> --name "<名前>" --password "<12文字以上>"
   ```

5. **R2 バケットを作る**（本番は APAC。`--location` は `weur`/`eeur`/`apac`/`wnam`/`enam`/`oc` から選ぶ）

   ```sh
   npx wrangler r2 bucket create sharehouse-signage --location apac
   ```

6. **Workers の Secret を登録する**（`wrangler secret bulk` で一括登録。値はこの文書に書かない。
   手元で JSON を作って渡す）

   ```sh
   npx wrangler secret bulk secrets.json --name sharehouse-signage
   rm secrets.json   # 平文の秘密鍵ファイルはコマンド後すぐ消す
   ```

   `secrets.json` の形式は `{"TURSO_DATABASE_URL": "...", "TURSO_AUTH_TOKEN": "...",
   "AUTH_SECRET": "...", "OPENWEATHER_API_KEY": "..."}`。`AUTH_SECRET` は 32 バイトの乱数を
   base64 にしたもの（例: `openssl rand -base64 32`）。

7. **ビルドしてデプロイする**（c 節と同じ）

   ```sh
   npm run build && npm run deploy
   ```

   このとき `wrangler.jsonc` の `r2_buckets` / `triggers` / `ratelimits` の設定も一緒に反映される
   （Cron・Rate Limiting binding・R2 バインディングはコード変更なしにこのデプロイで有効になる）。

8. **表示バンドルを公開する**（e 節）

   ```sh
   npm run build:display
   DISPLAY_BUNDLE_R2=remote TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... npm run publish:display
   ```

9. **スモーク確認**（本番で実施・確認済みの内容）

   - `GET /login` → 200
   - 未ログインで `GET /admin` → `/login` へ 307
   - 別 Origin からの更新系 POST → 403
   - 端末 API にトークンなしでアクセス → 401
   - 管理者アカウントでログイン成功
   - 端末の config 取得 → 200、同じ内容で再取得 → 304（`If-None-Match` 相当のキャッシュ確認）
   - 表示バンドルの Range 取得 → 206
   - heartbeat 送信 → 204

---

## c. 通常のデプロイ手順と旧版への戻し

### デプロイ

```sh
npm run build
npm run deploy
```

`deploy` は `vinext-cloudflare deploy --config dist/server/wrangler.json`（`package.json`）。
デプロイ後、`npx wrangler deployments list --name sharehouse-signage` で反映されたことを確認する
（直近 10 件が出る。`--json` を付けると機械可読な形式になる）。

### 旧版への切り戻し

`npx wrangler rollback --help` で存在を確認済み。使い方:

```sh
# 対象バージョンを確認する
npx wrangler deployments list --name sharehouse-signage

# 直前のバージョンへ戻す（version-id を省略すると対話的に選べる）
npx wrangler rollback <version-id> --name sharehouse-signage --message "<戻す理由>"
```

- `rollback` はコードとバインディング設定を指定バージョンへ戻すが、Turso のデータや R2 の中身は
  戻さない（それらは Worker のコード外にある）。DB のスキーマを変える版からロールバックする場合は
  d 節の順序を踏んでいれば、旧コードが新しい列を無視して動く設計になっているはずなので確認する。
- 本番相手に `wrangler rollback` を実際に打つ前に、`--help` の内容と対象の `version-id` を
  必ず見直す（このコマンドは本番のコードを即座に切り替える）。
- **未実施**: 本番での切り戻しの実演はまだ行っていない（task_025 の残作業）。

---

## d. DB スキーマ変更の順序

旧版と新版の Worker が一時的に共存しても壊れないようにするため、次の順序を必ず守る。

1. **列を追加する**（削除・改名はしない）。マイグレーションは `db/migrations/` に追加し、
   `npm run db:generate` で生成、本番へは
   `TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... npm run db:migrate` で適用する。
   この時点では旧コードはまだ動いていて、追加した列を読み書きしないので影響しない。
2. **新しい列を使うコードをデプロイする**（b/c 節の手順）。デプロイの切り替え中も旧バージョンが
   数秒〜数十秒残ることがあるが、旧バージョンは追加した列を無視するだけで壊れない。
3. **（列を置き換える場合のみ）旧列を使うコードが完全になくなったのを確認してから、
   別マイグレーションで旧列を削除する。** 削除は新しいコードが確実に行き渡ってから、日を空けて
   行う（すぐには消さない）。
4. **列の削除・改名を、新コードのデプロイと同じマイグレーションに含めない。** 同時に行うと、
   デプロイの切り替え中に残る旧バージョンが失敗する。

---

## e. 表示バンドルの公開

Pi が読み込む静的な表示バンドル（`dist-display/`）を R2 に置き、DB の `display_bundles` を
更新する。`scripts/publish-display-bundle.ts` が実体（zip 化 → SHA-256 → R2 へ put →
`display_bundles` に登録して `is_current` を切り替え）。

```sh
npm run build:display
DISPLAY_BUNDLE_R2=remote \
  TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... \
  npm run publish:display
```

- `DISPLAY_BUNDLE_R2` は `local`（既定、`wrangler` のローカル R2）か `remote`（本番の R2）。
  本番公開では必ず `remote` を指定する。
- `DISPLAY_BUNDLE_R2_BUCKET` でバケット名を上書きできる（既定は `wrangler.jsonc` の
  `sharehouse-signage`）。
- 公開すると `display_bundles.is_current` が新しいバンドルに切り替わり、それを含む config の
  `version`（内容の SHA-256、`lib/config-builder.ts` の `computeConfigVersion`）が変わる。Pi は
  既定 10 秒間隔（`raspberry-pi/agent/config.py` の `sync_interval_seconds`）で config を
  ポーリングしているので、通常は数秒〜十数秒で新しいバンドルに切り替わる。

---

## f. バックアップと復元

### バックアップ

`scripts/backup-db.sh` が Turso DB を SQL ダンプ（`turso db shell <db> .dump`）→ gzip 圧縮
→ R2 の `backups/` に保存する（`npx wrangler r2 object put --remote`）。

```sh
scripts/backup-db.sh                    # 既定: og-signage を sharehouse-signage の backups/ へ
scripts/backup-db.sh og-signage sharehouse-signage   # 明示指定も可
```

- 保存先キー: `backups/<DB名>-<UTC日時>.sql.gz`（例: `backups/og-signage-20260925-030000.sql.gz`）。
- 30 日より古いバックアップの削除はこのスクリプトでは行わない。このバケットには現状
  `backups/` 用の有効期限ルールが無い（確認済み: `npx wrangler r2 bucket lifecycle list
  sharehouse-signage` で出るのは既定のマルチパート中断ルールのみ）。手動で以下のどちらかを行う。

  **推奨: R2 のライフサイクルルールを一度だけ設定する**（以後は自動で削除される。
  `wrangler r2 bucket lifecycle add` の存在とオプションは `--help` で確認済みだが、
  まだ本番には設定していない。設定は状態変更なので、実行する前に対象バケット名を
  必ず確認する）

  ```sh
  npx wrangler r2 bucket lifecycle add sharehouse-signage expire-old-backups backups/ --expire-days 30
  ```

  **その場限りで個別に消す場合**: この版の `wrangler`（4.138.0）にはバケット内のオブジェクト
  一覧を取るサブコマンドが無い（`wrangler r2 object` は `get` / `put` / `delete` のみ、
  `--help` で確認済み）。Cloudflare ダッシュボードの R2 画面でキー名を確認してから、
  そのキーを個別に消す。

  ```sh
  npx wrangler r2 object delete sharehouse-signage/backups/<消す対象のキー> --remote
  ```

- **定期実行**: cron やその他のスケジューラからこのスクリプトを毎日実行する運用を想定しているが、
  そのスケジューラ自体（GitHub Actions・OS の cron など）はこの task ではまだ用意していない。
  当面は手動実行、または保守担当が別途スケジューラを用意する。
- **動作確認方法**: ローカルの一時 DB（`turso dev` または `file:`）と、R2 の `--local` モードで
  ダンプ・圧縮・アップロードの一連の流れを確認済み（本番には一切触れない）。手順:

  ```sh
  turso dev --port 18080 --db-file /tmp/test.db &
  turso db shell http://127.0.0.1:18080 "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO t (name) VALUES ('a');"
  R2_REMOTE_FLAG=--local R2_PERSIST_TO=/tmp/r2-local \
    scripts/backup-db.sh http://127.0.0.1:18080 test-bucket
  ```

  ダンプ内容を R2（ローカル）から取得して展開し、元のテーブル内容と一致することを確認した。

### 復元

ダンプから復元するときは、**既存の `og-signage` を上書きしない**。新しい DB を作ってそこへ
流し込み、Secret を新しい DB に差し替える。

1. バックアップを取得して展開する。

   ```sh
   npx wrangler r2 object get sharehouse-signage/backups/<対象のキー> --remote --file restore.sql.gz
   gunzip restore.sql.gz   # restore.sql ができる
   ```

2. 復元用の新しい Turso DB を作る（既存の `og-signage` とは別名にする。例:
   `og-signage-restore-<日付>`）。

   ```sh
   turso db create og-signage-restore-20260925 --group default
   ```

3. ダンプを流し込む。`turso db shell <db>` は SQL 引数を省略すると標準入力から読む
   （`gunzip -c ... | turso db shell <URL または DB名>` の形でローカル環境で動作確認済み）。

   ```sh
   cat restore.sql | turso db shell og-signage-restore-20260925
   ```

   （`turso db create` には `--from-dump <ファイル>` という一括作成オプションもある
   `turso db create --help` で存在は確認したが、本番相手には未実行・未検証。上記の
   「空の DB を作ってから流し込む」手順を優先する）

4. 中身を確認する（件数など）。

   ```sh
   turso db shell og-signage-restore-20260925 "SELECT count(*) FROM events;"
   ```

5. 新しい DB の接続情報を取得し、Workers の Secret を差し替える（h 節と同じ手順）。

   ```sh
   turso db show og-signage-restore-20260925 --url
   turso db tokens create og-signage-restore-20260925
   ```

   得られた URL とトークンで `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` を
   `wrangler secret bulk` で差し替える（値はこの文書に書かない）。

6. 差し替え後、端末の config の `version`（内容の SHA-256）は必ず変わる。Pi は既定 10 秒間隔で
   ポーリングしているため、数秒〜十数秒で新しい内容に再同期される。`/admin/devices` の
   最終応答時刻や、必要なら `wrangler tail sharehouse-signage` で
   `GET /api/device/config` が新しい `version` を返していることを確認する。
7. 復元と旧 DB の整合が取れたことを確認できたら、古い DB（`og-signage`）は誤操作防止のため
   すぐには消さず、しばらく残しておく。

- **未実施**: 本番相手の復元演習（新 DB 作成 → 流し込み → Secret 差し替え → Pi 再同期の確認）は
  まだ行っていない。task_025 の残作業。

---

## g. 管理者のパスワードを忘れたとき

パスワードのリセット機能は無いため、別の管理者アカウントを作って対応する。

1. 新しい管理者を作る。

   ```sh
   TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... \
     npm run admin:create -- --email <新しいメール> --name "<名前>" --password "<12文字以上>"
   ```

2. 新しいアカウントでログインし、`/admin` の利用者管理画面から、パスワードを忘れた元の
   アカウントを無効化する（役割・利用者管理の画面。`task_019` で実装済み）。
3. 元のアカウントを引き続き使いたい場合は、無効化ではなく別途 DB を直接更新して
   `password_hash` を新しいものに差し替える方法もあるが、通常は上記の「別アカウントを作って
   無効化」で十分なので、DB 直接更新は最終手段とする。

---

## h. Secret の差し替え

`TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN` / `AUTH_SECRET` / `OPENWEATHER_API_KEY` のいずれかを
差し替えるとき。

```sh
npx wrangler secret bulk secrets.json --name sharehouse-signage
rm secrets.json
```

- `secrets.json` は `{"KEY": "値", ...}` の JSON。差し替えたいキーだけを含めればよい
  （`wrangler secret bulk --help`: 指定したキーだけ作成・更新される。値を `null` にすると
  そのキーを削除する）。
- 現在登録されているキーの一覧（値は出ない）は `npx wrangler secret list --name
  sharehouse-signage` で確認できる。
- `AUTH_SECRET` を差し替えると、既存のログインセッション（JWT）がすべて無効になる
  （再ログインが必要になる）。利用者の少ない時間帯に行う。
- Secret の差し替えは新しいデプロイを伴わずに即座に反映される（Worker の再デプロイは不要）。

---

## i. Pi の導入・更新・交換

`raspberry-pi/README.md` を参照する。要点だけ書くと:

- **新規導入**: 管理画面の「端末」でトークンを発行して `config.json` をダウンロードし、
  `sudo ./install.sh --config config.json --bundle dist-display.zip` を実行する。
- **更新**: 新しい版の `raspberry-pi/` を Pi に置いて `sudo ./update.sh` を実行する
  （`current`/`previous` の原子的な切り替え。生存確認に失敗すると自動で直前の版へ戻る）。
- **交換（新しい SD カード）**: `raspberry-pi/README.md` の「新しい SD カードから導入する」と
  同じ手順。既存の端末を無効化してから新しいトークンを発行するか、既存のトークンを
  再発行して古い SD カードを無効化する。

---

## j. 障害時の確認点

1. **Workers のログ**: `npx wrangler tail sharehouse-signage`（`--format json` で
   `cpuTime` / `wallTime` などの詳細が出る。`--status error` でエラーのみに絞れる）。
2. **端末画面の状態**: `/admin/devices`（Administrator のみ）で、各端末の最終応答時刻・
   heartbeat の内容を確認する。Pi 側の heartbeat 送信間隔は既定 60 秒
   （`raspberry-pi/agent/config.py` の `heartbeat_interval_seconds`）。しばらく応答が
   途絶えていれば、Pi 側のネットワークかエージェントの異常を疑う。
3. **Cron の初回起動**: デプロイ直後・Cron 設定変更直後は、初回起動まで最大 40 分程度
   かかった実績がある（検証時の実測値は約 42 分、`docs/spikes/workers.md` 6 節）。デプロイ
   直後に天気やクリーンアップが動いていなくても、直ちに障害とは判断しない。
4. **R2 / Turso の状態**: `npx wrangler r2 bucket info sharehouse-signage`（オブジェクト数・
   サイズ）、`turso db show og-signage`（DB の状態）。
5. **デプロイ履歴**: `npx wrangler deployments list --name sharehouse-signage` で、直近の
   デプロイ・Secret 変更のタイミングを確認する。

---

## k. 別件資源に触らない注意

同じ Cloudflare / Turso アカウントには、本アプリと無関係な別件の資源がある。

- R2 バケット `weworksignage`
- Turso DB `non-turn-signage`

`wrangler r2 bucket list` や `turso db list` を実行すると、これらが本アプリの資源
（`sharehouse-signage` バケット、`og-signage` DB）と並んで表示される。名前が似ているため、
コマンドを打つ前に対象名が **`sharehouse-signage`** または **`og-signage`** であることを
必ず確認すること。特に破壊的な操作（`wrangler r2 bucket delete` や `turso db destroy` など）は、
対象名を声に出して読み上げるくらいの慎重さで確認してから実行する。
