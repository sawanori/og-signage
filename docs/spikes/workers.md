# Workers 技術検証（task_002）

- 実施日: 2026-09-24
- 検証用 Worker: `og-signage-spike`（`https://og-signage-spike.snp-inc-info.workers.dev`、workers.dev にデプロイ）
- 検証用資源: R2 バケット `sharehouse-signage-spike`、Turso DB `og-signage-spike`（aws-ap-northeast-1）。検証後に Worker・バケット・DB をすべて削除した（末尾「後片付け」）。
- 検証コード: `spikes/workers/`（vinext の独立アプリ。`main: "./worker/index.ts"` の独自エントリ、`proxy.ts`、`app/api/*`、`app/actions`、`app/login`）。検証後に削除した。
- 計測は手元（東京、NRT 経由）からの curl。CPU 時間・壁時計時間は `wrangler tail --format json` の `cpuTime` / `wallTime`（ミリ秒）。
- アカウントの Workers プラン: 有料プランと判断した。根拠は `limits.cpu_ms: 300000` を入れた設定のデプロイが受理されたこと（無料プランは CPU 上限を変更できない）。プラン名は API 権限の都合で直接は確認できていない。

## 総括

| # | 項目 | 結果 |
|---|---|---|
| 1 | Auth.js Credentials + JWT、sessionVersion 照合 | 成功 |
| 2 | Server Action からの Turso 書き込み、読み取りトランザクション | 成功 |
| 3 | 別 Origin の Server Action・Route Handler の拒否 | 成功（Server Action は vinext が拒否、Route Handler は `proxy.ts` で拒否） |
| 4 | R2 マルチパートで 500MB アップロード | 成功 |
| 5 | R2 ストリーム中継で 500MB を Range 付き取得 | 代替で成功（vinext の Route Handler 経由は CPU を大量に使うため、`worker/index.ts` で vinext より前に中継する） |
| 6 | Cron Trigger | 成功（`wrangler dev` の手動起動と本番の定期起動の両方） |
| 7 | Rate Limiting binding | 成功（ただし制限は緩く、厳密な回数制限にはならない） |
| 8 | PBKDF2 所要時間 | 100,000 回は成功。600,000 回は Workers が非対応（エラー） |
| 9 | OpenWeatherMap 利用規約・呼び出し | 成功（無料プランは商用可、出典表示が必須。Worker からの呼び出しは 200） |
| 10 | 採用版の固定 | 済み |

---

## 1. Auth.js（Credentials + JWT）

- **結果**: 成功
- **採用する方式**: Auth.js `next-auth@5.0.0-beta.32`（`@auth/core@0.41.3`）。Credentials プロバイダー、`session.strategy = "jwt"`。`NextAuth(() => ({ secret: env.AUTH_SECRET, trustHost: true, ... }))` の遅延初期化で、`cloudflare:workers` の `env` から秘密鍵を読む。`jwt` コールバックで `userId`・`sessionVersion` を載せ、保護操作ごとに `auth()` の結果と DB の `is_active`・`role`・`session_version` を照合する関数を通す。
- **実測値**:
  - ログイン（`POST /api/auth/callback/credentials`、PBKDF2 100,000 回を含む）: CPU 35〜89ms、壁時計 150〜353ms。
  - 同じ試験を 3 回繰り返してすべて同じ結果になった。
- **根拠**（`https://og-signage-spike...` に対する curl）:
  - Cookie なしの `GET /api/whoami` → `401 {"ok":false,"reason":"no-session"}`
  - パスワード誤り → `302 /api/auth/signin?error=CredentialsSignin`
  - 正しいパスワード → `302`、`Set-Cookie: __Secure-authjs.session-token=...; HttpOnly; Secure; SameSite=Lax`
  - その Cookie で `GET /api/whoami` → `200 {"ok":true,"userId":"u1","role":"administrator","sessionVersion":1}`
  - `GET /api/auth/session` → `{"userId":"u1","sessionVersion":1,...}`
  - DB の `session_version` を 1 から 2 に上げると、同じ Cookie で `401 {"reason":"session-version-mismatch","jwt":1,"db":2}`。Server Action（認証必須のもの）も失敗し、書き込みは発生しなかった。
  - `is_active = 0` で `401 {"reason":"inactive"}`。戻すと `200`。
  - Server Action から `signIn("credentials", { redirectTo })` を呼ぶログイン画面も動作: `303 Location: /api/whoami` と session Cookie が返り、その Cookie で `whoami` が `200`。
- **注意点**:
  - `vinext check` の互換表は `next-auth` を「unsupported」としているが、上記の範囲（Route Handler・Server Action・`auth()`）では動いた。ほかの使い方（`auth` を middleware としてラップする形など）は試していない。
  - 初回デプロイ直後の 1 回だけ、ログインが 500 になった。Secret 登録直後の版切替の途中と見られ、その後は再現しなかった（原因は未確定）。
  - ローカル（`http://127.0.0.1`）では `auth()` がセッションを読めなかった。Auth.js が `x-forwarded-proto` が無いと `https` 扱いにし、`__Secure-` 付きの Cookie 名を探すため。ローカル開発では `AUTH_URL=http://localhost:...` を設定する。
  - Server Action 内の `signIn` はパスワード誤りで `CredentialsSignin` を投げる（500 になる）。本実装では `AuthError` を捕まえて画面にエラーを返す。
- 署名付き Cookie の自前セッション（代替案）は不要だったため試していない。

## 2. Server Action からの Turso 書き込み・読み取りトランザクション

- **結果**: 成功
- **採用する方式**: `@libsql/client@0.18.0` の `@libsql/client/web`（`createClient({ url, authToken })`）。読み取りは `client.transaction("read")`。
- **実測値**: `/api/tx`（トランザクション開始 → 件数 → 別接続で INSERT → 件数 → commit → 件数）の応答 0.15〜0.34 秒。
- **根拠**:
  - Server Action（JS なしのフォーム送信と同じ形式、`$ACTION_ID_...` 付き multipart）で `200`。Turso に `sa-same`・`sa-noorigin` の行ができた（`turso db shell` で確認）。
  - `/api/tx` の出力 3 回: `{"inTxBefore":4,"inTxAfterConcurrentWrite":4,"afterCommit":5}` など。トランザクション中は別接続の書き込みが見えず（スナップショット）、commit 後は見える。config を読み取りトランザクション内で組み立てる前提（計画 6 節 11）が成り立つ。

## 3. 別 Origin からの Server Action・Route Handler 呼び出し

- **結果**: 成功（Server Action は vinext 本体が拒否。Route Handler は vinext は検査しないため、`proxy.ts` で拒否できることを確認）
- **採用する方式**:
  - Server Action: vinext 本体の検査に任せる（`Origin` のホストと `Host` が違えば 403。Next.js と同じ動作）。
  - Route Handler: `proxy.ts`（Next.js 16 の名前。vinext は `middleware.ts` も読むが非推奨の警告を出し、両方あるとビルドエラー）で、更新系メソッドの `Origin` が自サイトでなければ 403 を返す。`Origin` が無い要求も 403 にする。
- **根拠**（curl で `Origin` を偽装）:

  | 対象 | Origin | 結果 |
  |---|---|---|
  | Server Action（フォーム形式） | 自サイト | 200（書き込みあり） |
  | Server Action（フォーム形式） | なし | 200（書き込みあり） |
  | Server Action（フォーム形式） | `https://evil.example` | 403 `Forbidden`（書き込みなし） |
  | Server Action（フォーム形式） | `null` | 403 |
  | Server Action（`Next-Action` ヘッダー形式） | `https://evil.example` | 403 |
  | Server Action（同上 + `X-Forwarded-Host: evil.example`） | `https://evil.example` | 403 |
  | Route Handler `POST /api/echo`（proxy なし） | 自サイト / evil / null / なし | すべて 200（拒否されない） |
  | Route Handler `POST /api/guarded/echo`（proxy あり） | 自サイト | 200 |
  | 同上 | evil / null / なし | すべて 403 |

  vinext の該当コード: `node_modules/vinext/dist/server/request-pipeline.js` の `validateCsrfOrigin`（`Origin` が無ければ通す、`null` は拒否、ホスト不一致は 403）。
- **注意点**: Server Action は `Origin` が無い要求を通す。現行のブラウザはフォームの POST と fetch の POST に `Origin` を付けるため実害は小さく、Cookie の `SameSite=Lax` も効く。

## 4. R2 マルチパートアップロード（Worker 経由、1 パート 10MB）

- **結果**: 成功
- **採用する方式**: vinext の Route Handler で `createMultipartUpload` → `resumeMultipartUpload(key, uploadId).uploadPart(n, request.body)` → `complete(parts)`。リクエスト本文をストリームのまま渡せた（`Content-Length` 付きの要求）。
- **実測値**:
  - 500MB（524,288,000 バイト、乱数）を 10MB × 50 パートで順番に送信: 50 パートすべて 200、合計 70 秒（手元の上り回線がボトルネック）。
  - 完了後の `head` のサイズ 524,288,000、ETag `...-50`。
  - 1 パートあたりの Worker: CPU 16〜44ms、壁時計 0.43〜0.80 秒。
- **根拠**: `POST /api/upload/start` → `PUT /api/upload/part?n=1..50`（`curl --data-binary`）→ `POST /api/upload/complete` の応答 `{"size":524288000,...} [200]`。

## 5. R2 本体のストリーム中継（500MB、Range 付き）

- **結果**: 代替で成功。vinext の Route Handler 経由でも取得はできたが CPU を大量に使うため、中継は `worker/index.ts`（Worker の独自エントリ）で vinext より前に処理する方式にした。同じ試験をやり直して成功した。
- **採用する方式**: `worker/index.ts` の `fetch` でパスを見て、媒体・バンドル中継だけ vinext を通さずに処理する。`env.MEDIA_BUCKET.get(key, { range: request.headers })` の `body` をそのまま `new Response(obj.body, { status: 206, headers })` で返し、`Content-Range` を `obj.range` と `obj.size` から組み立てる。
- **実測値**（`wrangler tail` の値）:

  | 経路 | 要求 | 状態 | 所要時間（curl） | Worker CPU | Worker 壁時計 |
  |---|---|---|---|---|---|
  | vinext Route Handler `/api/media` | 全体 500MB | 200 | 31.8 秒 | **16,778ms** | 31,632ms |
  | 同上 | `Range: bytes=262144000-`（250MB） | 206 | 44.0 秒 | **19,826ms** | 43,764ms |
  | 同上（1 回目の計測） | `Range: bytes=0-262143999` | 206 | 26.0 秒 | 13,396ms | 25,936ms |
  | 独自エントリ `/raw/media` | 全体 500MB | 200 | 9.6 秒 | **0ms** | 68ms |
  | 同上 | `Range: bytes=262144000-` | 206 | 6.7 秒 | **1ms** | 74ms |

  - どの経路でもエラーは無く、取得したファイルの SHA-256 は元ファイルと一致（`45211ac1...`）。前半・後半の Range を連結したものも一致。
  - `Content-Range: bytes 262144000-524287999/524288000`、`bytes 100000000-100000999/524288000`（中身も一致）、接尾辞指定 `bytes=-1000` → `bytes 524287000-524287999/524288000`。
  - 範囲外（`bytes=600000000-`）は R2 が例外を投げ、検証コードでは 500 になった。本実装では 416 を返す処理が要る。
- **原因**: vinext が Route Handler の応答本文を JS の `ReadableStream` で包み直し、チャンクごとに `read()`/`enqueue()` する（`node_modules/vinext/dist/server/app-route-handler-execution.js` の `deferAppRouteHandlerCleanup`）。そのため本文の転送が JS の CPU 時間になる。有料プランの既定の CPU 上限（30 秒）に近く、回線が遅い Pi では超えるおそれがある。独自エントリでは R2 の本文がそのまま流れ、CPU はほぼ 0。
- **注意点**: 管理画面の素材中継（`GET /api/media/[id]/file`）も大きな動画を返すなら同じ問題が出る。500MB 級を返す経路はすべて独自エントリ側で処理する。アップロード（項目 4）は 1 パート 16〜44ms で問題ない。

## 6. Cron Trigger

- **結果**: 成功（`wrangler dev --test-scheduled` での手動起動と、本番の定期起動の両方）
- **採用する方式**: `wrangler.jsonc` の `main` を `./worker/index.ts` にし、そこで vinext の `fetch` を呼び、`scheduled` を足して `export default { fetch, scheduled }` とする。vinext は `worker/index.ts` があればそれを入口として扱う（`vinext/dist/init-cloudflare.js` の `resolveWorkerEntry`）。

  ```ts
  import handler from "vinext/server/fetch-handler";
  export default {
    fetch: (req, env, ctx) => handler.fetch(req, env, ctx),
    async scheduled(controller, env, ctx) { /* ... */ },
  };
  ```

- **根拠**:
  - `vinext build` 後に `wrangler dev --config dist/server/wrangler.json --test-scheduled` で起動。wrangler 4.138.0 では手動起動の URL が `/__scheduled` ではなく `/cdn-cgi/handler/scheduled?cron=...`（`/__scheduled` は vinext の 404 になった）。
  - `curl 'http://127.0.0.1:8799/cdn-cgi/handler/scheduled?cron=*/30+*+*+*+*'` → 200。Turso に `cron:*/30 * * * *` の行ができた。
  - 本番デプロイでは `schedule: * * * * *` が登録され、Cloudflare API（`/workers/scripts/og-signage-spike/schedules`）でも `"cron": "* * * * *"` を確認した。
- **本番の定期起動**: 成功。ただし登録から初回の起動まで約 42 分かかった。
  - 最後にトリガーを更新したデプロイ: 2026-09-24T14:46:30Z（API の `modified_on`）。初回の起動: 15:28:45Z（GraphQL `workersInvocationsScheduled`、`status: success`、CPU 4.1ms）。
  - 以後は毎分起動し、16:02:45Z までに Turso に `cron:* * * * *` の行が 35 件できた。起動ごとの CPU は 0.7〜4.1ms。
  - 14:35〜15:22 の間は起動が 0 件だった（同じアカウントの別 Worker の Cron は 5 分ごとに動いていた）。公式ドキュメントは反映まで最大 15 分としているが、今回はそれより長かった。原因は不明。
  - 本番導入後の最初の確認では、Cron の反映に時間がかかることを前提にする（デプロイ直後に動かなくても直ちに失敗とは判断しない）。

## 7. Rate Limiting binding

- **結果**: 成功（binding は動く。ただし制限の効き方は緩い）
- **採用する方式**: `ratelimits` binding（`simple: { limit: 10, period: 60 }`、`namespace_id` はアカウント内で一意の整数文字列）。`env.LOGIN_RATE_LIMITER.limit({ key })` の `success` で判定。
- **実測値**:
  - 同じ接続を使い回して 30 回連続で呼ぶ: ちょうど 10 回 `success: true`、残り 19 回 `false`（vinext の Route Handler 経由・独自エントリ経由のどちらも同じ）。
  - 1 回ごとに新しい接続で呼ぶ（別の curl を 14〜40 回、6 並列 60 回）: すべて `success: true` で、制限がかからなかった。
- **根拠**: 公式ドキュメント（developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/）の記述「permissive, eventually consistent, and intentionally designed to not be used as an accurate accounting system」「The underlying counters are cached on the same machine that your Worker runs in」のとおり、カウンタはマシンごとにキャッシュされ、別マシンに振られた要求にはすぐ効かない。
- **注意点**: ログインの総当たり対策としてはこれだけでは弱い。同じメールアドレスへの連続失敗は DB 側の失敗回数でも止めるのが確実（task_006 に記載）。

## 8. PBKDF2（Web Crypto、SHA-256）

- **結果**: 100,000 回は成功。600,000 回は Workers が対応していない（失敗）。
- **採用する方式**: 反復回数 100,000 回（Workers の上限値）。保存形式に回数を含め（`pbkdf2$100000$salt$hash`）、将来の変更に備える。
- **実測値**（各 5 回、`wrangler tail` の CPU 時間）:

  | 反復回数 | 状態 | CPU | 壁時計 |
  |---|---|---|---|
  | 1（基準） | 200 | 3〜6ms | 3〜7ms |
  | 100,000 | 200 | 18〜56ms（中央値 29ms） | 19〜58ms |
  | 600,000 | 500 | — | — |
  | 100,001 | 500 | — | — |

- **根拠**: 600,000 回のエラー内容（`wrangler tail`）: `NotSupportedError: Pbkdf2 failed: iteration counts above 100000 are not supported (requested 600000).`
- **CPU 上限との関係**: 100,000 回の 18〜56ms は、有料プランの既定の CPU 上限（30 秒）に対して十分小さい。無料プランの上限（10ms）では超える。

## 9. 天気（OpenWeatherMap）

- **結果**: 成功。利用規約の原文を確認し、無料プランは商用利用可、出典表示は必須。Worker からの呼び出しも成功した。
- **呼び出し試験**: デプロイした Worker に `OPENWEATHER_API_KEY` を `wrangler secret bulk` で渡し、`GET https://api.openweathermap.org/data/2.5/weather?lat=35.4437&lon=139.638&units=metric&lang=ja&appid=...` を呼んだ。結果は `{"status":200,"name":"横浜市","weather":"厚い雲","temp":24.37}`（2026-09-24 16:03 UTC ごろ）。21:5x（JST）ごろのメインでの試験では 401 Invalid API key だったが、キーが有効になったあとは通った。キーの値は記録しない。
- **採用する方式**: 無料プランを使い、表示ページの天気欄の近くに出典を表示する（「Weather data © OpenWeather」と https://openweathermap.org/ へのリンク相当の表記）。
- **原文**（2026-09-24 取得）:
  - 料金ページの詳細（https://openweathermap.org/full-price）:
    - 「All automated self-service plans are provided under the ODbL (Open Database License). Commercial use is allowed.」
    - 自己申込みプランの説明: 「API access under the ODbL licence」「Commercial and non-commercial use」「Licence Requirement: Visible attribution to OpenWeather in your application or service」
    - 「In most commercial use cases, you only need to provide attribution on the screen or page where weather data appears. Attribution placed only in hidden documentation or deep legal pages is not sufficient.」「Recommended line: Weather data © OpenWeather」
    - 比較表の「Attribution」行は Free を含む全プランで「Required」、「License」行は全プラン「ODbL」。
  - FAQ（https://openweathermap.org/faq）:
    - 「Can I use OpenWeather’s APIs commercially? Yes, you can.」
    - 「For the plans between Free and Professional, the attribution requirement is obligatory. When it is required by your license you should place the following information in the visible part of your solution: ‘Weather data provided by OpenWeather’ / Hyperlink to our website https://openweathermap.org/ / OpenWeather logo.」
  - 販売条件（https://openweather.co.uk/api/files/file/OpenWeather_T%26C_of_sale.pdf、G 節）: 「Products and services are provided under terms of Creative Commons Attribution-ShareAlike 4.0 International license (CC BY-SA 4.0). Data and database are open and licensed by Open Data Commons Open Database License (ODbL).」
  - サイト利用規約（https://openweather.co.uk/api/files/file/Openweather_website_terms_and_conditions_of_use.pdf）はウェブサイト自体の利用条件で、API データの商用可否の規定は無い。指示にあった `.../storage/app/media/Terms/Openweather_website_terms_and_conditions_of_use.pdf` は 404 だったため、料金ページのリンク先を使った。
  - 補足: 表示ページは画面なので、出典はリンクの代わりに文字で出す（サイネージではクリックできない）。ロゴの掲示は FAQ の推奨で、必須かどうかは原文から判断できない。

## 10. 採用する版

`package.json` は完全固定（`^` なし）、`package-lock.json` をコミットする。検証に使った版:

| パッケージ | 版 |
|---|---|
| next | 16.3.6 |
| vinext | 1.0.0-beta.12 |
| @vinext/cloudflare | 1.0.0-beta.10 |
| @cloudflare/vite-plugin | 1.59.0 |
| vite | 8.3.1 |
| react / react-dom | 19.3.0 |
| wrangler | 4.138.0 |
| typescript | 6.0.3 |
| @libsql/client | 0.18.0（`@libsql/client/web`） |
| next-auth | 5.0.0-beta.32（今回追加。依存の `@auth/core` は 0.41.3） |

- `compatibility_date: 2026-09-24`、`compatibility_flags: ["nodejs_compat"]`。

## 計画への反映

- 7 節 Web（認証・CSRF・Cron・R2 中継・レート制限・PBKDF2 の回数）を更新した。
- 11 節の `middleware.ts` を `proxy.ts` に、`worker/scheduled.ts` の入口として `worker/index.ts` を追記した。
- task_006・008・012・013 に上記の方式を追記した。

## 後片付け

2026-09-24 16:05 UTC ごろに次を削除し、削除を確認した。

| 資源 | 削除コマンド | 確認 |
|---|---|---|
| Worker `og-signage-spike`（Secret・Cron・Rate Limiting binding を含む） | `wrangler delete --name og-signage-spike --force` | workers.dev の URL が 404。API のスクリプト一覧に無い |
| R2 バケット `sharehouse-signage-spike`（オブジェクト 2 件を先に削除） | `wrangler r2 object delete ... --remote`、`wrangler r2 bucket delete sharehouse-signage-spike` | `wrangler r2 bucket list` に無い |
| Turso DB `og-signage-spike` | `turso db destroy og-signage-spike --yes` | `turso db list` に無い |
| Rate Limiting の namespace（`namespace_id: "4201"`） | 個別の資源は無く、Worker の設定の中の値だけ。Worker の削除で使われなくなった | — |
| `spikes/workers/`（検証コードと `.dev.vars`） | `rm -rf spikes` | 存在しない |

- `package.json` に検証で足した依存は `next-auth@5.0.0-beta.32` のみ。本番で使うため残した。
