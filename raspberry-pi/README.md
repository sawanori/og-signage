# Raspberry Pi（表示端末）

Raspberry Pi 4 + Raspberry Pi OS Bookworm 64bit（デスクトップ付き）で、電源を入れると人手なしで
表示が始まる端末を作る。GUI は Bookworm 標準の Wayland（labwc）を仮の前提にしている。
実機で決める項目は末尾の「task_003 で確定させる項目」にまとめた。

## 構成

```text
/opt/sharehouse-signage/
    releases/<version>/agent/   Agent 本体（版は agent/*.py の内容のハッシュ先頭 12 桁）
    current  -> releases/<version>
    previous -> releases/<version>   直前の版（update.sh --rollback の戻り先）
/var/lib/sharehouse-signage/        表示データ（世代・媒体・表示バンドル。Agent が管理）
/etc/sharehouse-signage/
    agent.json    管理画面からダウンロードした config.json（権限 600、表示用ユーザー所有）
    kiosk.env     Agent のポート・画面回転（install.sh が agent.json から作る）
/var/cache/kiosk                    Chromium のプロファイル・キャッシュ・一時ファイル（tmpfs 256MB）
~<user>/.config/systemd/user/       signage-agent.service、chromium-kiosk.service
~<user>/.config/labwc/autostart     画面回転と、上の 2 つのサービスの起動
```

起動の流れ: 電源投入 → lightdm が表示用ユーザーで自動ログイン → labwc が `autostart` を実行 →
画面回転（縦置き時）→ Wayland の環境変数をユーザーの systemd に渡す → `signage-agent` と
`chromium-kiosk` を起動 → Chromium は Agent の `http://127.0.0.1:<port>/local/config.json` が
応答するまで待ってから `http://127.0.0.1:<port>/` を開く。

- どちらのサービスも `Restart=always`。kill しても 3 秒後に戻る。Agent の watchdog は
  表示の応答が途絶えると Chromium を再起動し、それでも戻らなければ非 0 で自身を終了する。
- Chromium は起動のたびにプロファイルを消すので、強制終了のあとでも復元ダイアログは出ない。
- journald は揮発メモリだけに保存し、上限 64MB（`os/journald/`）。再起動でログは消える。

## 新しい SD カードから導入する

用意するもの:

- Raspberry Pi OS Bookworm 64bit（デスクトップ付き）を書き込んだ高耐久 microSD（32GB 以上）
- 電池付き RTC（DS3231）を I2C に接続
- 管理画面の「端末」で登録（またはトークン再発行）してダウンロードした `config.json`
- 表示バンドルの zip（`npm run build:display` などで作った `dist-display/` を zip にしたもの。
  `npm run publish:display` が R2 に置くのと同じ zip でよい）

手順:

1. Raspberry Pi Imager で OS を書き込む（ホスト名・Wi-Fi・SSH を設定しておくと楽）。
2. 起動して SSH でつなぎ、このリポジトリの `raspberry-pi/` ディレクトリ、`config.json`、
   バンドルの zip を Pi へ置く（例: `scp -r raspberry-pi config.json dist-display.zip pi@<host>:`）。
3. 導入する:

   ```sh
   cd ~/raspberry-pi
   sudo ./install.sh --config ~/config.json --bundle ~/dist-display.zip
   ```

   表示用ユーザーは既定で `signage`（無ければ作る）。既存ユーザーを使うなら `--user pi` のように渡す。
   何度実行しても同じ状態になる。`config.json` を差し替えるとき（トークン再発行など）も
   `--config` を付けて再実行すればよい。
4. `sudo reboot`。自動ログインのあと表示が始まる。初期表示は同梱したバンドルと最小の config で、
   ネットにつながると初回同期でサーバーの config に置き換わる。
5. 導入後、`config.json` と zip は Pi の中から消してよい（`config.json` はトークンを含む）。

install.sh がすること: 依存パッケージの導入（`os/packages.txt`）、表示用ユーザーの作成と
自動ログイン・Wayland（labwc）・画面の自動消灯無効の設定（raspi-config の非対話モード）、
Agent の配置と `current` の付け替え、`/var/lib/sharehouse-signage` の作成、`agent.json`（600）と
`kiosk.env` の配置、初期表示バンドルの世代作成、journald の設定、tmpfs の有効化、
`/boot/firmware/config.txt` への RTC 設定の追記と fake-hwclock の削除、ユーザーサービスと
labwc の autostart の配置。

## 更新する

新しい版の `raspberry-pi/` ディレクトリを Pi に置いて実行する。

```sh
cd ~/raspberry-pi-new
sudo ./update.sh
```

1. `agent/*.py` を `/opt/sharehouse-signage/releases/<version>/` に展開する（同じ中身なら同じ版なので何もしない）。
2. `current` を新しい版へ、`previous` を今までの版へ付け替える（原子的なリネームのあと親ディレクトリを fsync）。
3. `signage-agent` を再起動し、生存を確かめる:
   - 120 秒以内に `http://127.0.0.1:<port>/local/config.json` が HTTP で応答する（`--timeout` で変更可）
   - その後 30 秒のあいだ、サービスが止まらず再起動もしない（`--stable` で変更可）
   - 再起動以降のログに Heartbeat スレッドの例外（`heartbeat loop iteration failed`）や `Traceback` が無い
4. 失敗したら直前の版へ戻して再起動し、終了コード 1 で終わる（戻した版も動かなければ 2）。

`agent.json` の `agentVersion` も版に合わせて書き換えるので、管理画面の端末一覧に版が出る。
表示バンドルの更新は update.sh ではなく、管理画面からの公開と Agent の同期で行う（切替後に
表示が応答しなければ Agent が直前の世代へ戻す）。

## 戻す

直前の版（`/opt/sharehouse-signage/previous`）へ戻す:

```sh
sudo ./update.sh --rollback
```

`current` と `previous` を入れ替えて再起動し、更新と同じ生存確認をする。もう一度実行すると元に戻る。
それより前の版へ戻すときは、その版の `raspberry-pi/` ディレクトリで `sudo ./update.sh` を実行する
（`releases/` に残っていれば展開は省かれる）。

## 状態の確認

```sh
systemctl --user status signage-agent chromium-kiosk      # 表示用ユーザーで
sudo journalctl _SYSTEMD_USER_UNIT=signage-agent.service -f
readlink /opt/sharehouse-signage/current /var/lib/sharehouse-signage/current
sudo hwclock -r; timedatectl
```

## task_003 で確定させる項目

実機が無い段階で仮に決めたもの。実機で確かめて、ここと該当ファイルのコメントを直す。

| 項目 | 仮の値 | 場所 |
|---|---|---|
| GUI 起動方式（Wayland/labwc か X11 か） | labwc（`raspi-config nonint do_wayland W3`） | `install.sh` |
| 自動ログインの設定方法 | `SUDO_USER=<user> raspi-config nonint do_boot_behaviour B4` で表示用ユーザーになるか | `install.sh` |
| ユーザーの labwc autostart がシステム側（パネル・swayidle）を置き換えるか | 置き換える前提 | `os/labwc/autostart` |
| 画面の自動消灯が起きないこと | swayidle を起動しない + `raspi-config nonint do_blanking 1` | `os/labwc/autostart`、`install.sh` |
| 画面回転の出力名と transform | `HDMI-A-1`、縦置きは `90`（270 かもしれない） | `install.sh`（kiosk.env の生成）、`os/labwc/autostart` |
| HDMI 出力を切る方法、切った後に回転が保たれるか | `wlr-randr --output HDMI-A-1 --off/--on` | `agent/platform.py`（RealPlatform） |
| mpv の起動フラグ（Wayland での全画面・回転・ハードウェアデコード） | `--fullscreen --no-osc ...` | `agent/platform.py`（RealPlatform） |
| Chromium の実行ファイル名・パッケージ名 | `/usr/bin/chromium`、パッケージ `chromium` | `systemd/chromium-kiosk.service`、`os/packages.txt` |
| Chromium の `--ozone-platform=wayland` の要否 | 付ける | `systemd/chromium-kiosk.service` |
| マウスカーソルを隠す方法 | 未対応 | — |
| WAYLAND_DISPLAY をユーザーの systemd へ渡す方法 | autostart で `systemctl --user import-environment` | `os/labwc/autostart` |
| RTC から起動時に時刻が戻ること | `dtoverlay=i2c-rtc,ds3231`、fake-hwclock 削除、`/lib/udev/hwclock-set` の systemd 判定を無効化 | `os/boot/config.txt.snippet`、`install.sh` |
| rsyslog など journald 以外に /var/log へ書くものが無いか | journald は `ForwardToSyslog=no` | `os/journald/sharehouse-signage.conf` |
| tmpfs の大きさ | 256MB | `os/tmpfs/var-cache-kiosk.mount` |

## 実機で確かめること（task_022 の完了条件）

- 電源投入から 3 分以内に表示される
- `pkill -f agent.main`、`pkill chromium` のそれぞれで自動で戻る
- 壊れた版（例: `agent/main.py` に構文エラー）を `update.sh` で入れると旧版へ戻る
- ネットを切ったまま再起動しても表示される
