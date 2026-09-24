#!/usr/bin/env bash
# Share House Signage: 新しい Raspberry Pi OS（Bookworm 64bit、デスクトップ付き）への導入。
#
# 使い方（Pi 上で、このリポジトリの raspberry-pi/ ディレクトリを置いた状態で）:
#   sudo ./install.sh --config /path/to/config.json --bundle /path/to/dist-display.zip [--user signage]
#
#   --config  管理画面の端末登録・トークン再発行でダウンロードした config.json。
#             2 回目以降で /etc/sharehouse-signage/agent.json が既にあれば省略できる。
#   --bundle  表示バンドルの zip（dist-display を zip にしたもの）。current 世代がまだ無いときに
#             初期表示として置く。current 世代が既にあれば使わない。
#   --user    表示用のユーザー（無ければ作る。既定 signage）。
#
# 何度実行しても同じ状態になる（冪等）。最後に再起動が必要。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

APP_BASE=/opt/sharehouse-signage
RELEASES_DIR="$APP_BASE/releases"
DATA_DIR=/var/lib/sharehouse-signage
ETC_DIR=/etc/sharehouse-signage
CONFIG_FILE="$ETC_DIR/agent.json"
KIOSK_ENV="$ETC_DIR/kiosk.env"
KIOSK_TMPFS=/var/cache/kiosk
BOOT_CONFIG=/boot/firmware/config.txt

config_src=""
bundle_src=""
user="signage"

log() { printf '[install] %s\n' "$*"; }
die() { printf '[install] エラー: %s\n' "$*" >&2; exit 1; }

usage() {
    sed -n '4,13p' "$0" | sed 's/^# \{0,1\}//'
    exit 2
}

while [ $# -gt 0 ]; do
    case "$1" in
        --config) config_src="${2:-}"; shift 2 ;;
        --bundle) bundle_src="${2:-}"; shift 2 ;;
        --user) user="${2:-}"; shift 2 ;;
        -h|--help) usage ;;
        *) die "不明な引数: $1" ;;
    esac
done

[ "$(id -u)" -eq 0 ] || die "root で実行してください（sudo ./install.sh ...）"
[ -d "$SCRIPT_DIR/agent" ] || die "$SCRIPT_DIR/agent がありません"
[ -n "$user" ] || die "--user が空です"
if [ -n "$config_src" ]; then
    [ -f "$config_src" ] || die "config.json が見つかりません: $config_src"
elif [ ! -f "$CONFIG_FILE" ]; then
    die "初回は --config が必要です"
fi
if [ -n "$bundle_src" ]; then
    [ -f "$bundle_src" ] || die "表示バンドルの zip が見つかりません: $bundle_src"
fi

# ---------------------------------------------------------------- 共通関数

# シンボリックリンクを原子的に付け替え、親ディレクトリを fsync する（電源断で付け替えが失われないように）
switch_link() {
    local link="$1" target="$2"
    local tmp
    tmp="$(dirname "$link")/.$(basename "$link").tmp.$$"
    ln -sfn "$target" "$tmp"
    mv -Tf "$tmp" "$link"
    sync "$(dirname "$link")"
}

# Agent 本体（agent/*.py）の内容から版を決める（同じ中身なら同じ版）
agent_version_of() {
    (cd "$1" && find agent -maxdepth 1 -type f -name '*.py' | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -c1-12)
}

# agent.json の agentVersion を書き換える（Heartbeat で管理画面に出る版。権限と所有者は保つ）
set_agent_version() {
    python3 - "$CONFIG_FILE" "$1" <<'PY'
import json, os, sys
path, version = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as f:
    data = json.load(f)
if data.get("agentVersion") == version:
    sys.exit(0)
data["agentVersion"] = version
st = os.stat(path)
tmp = path + ".tmp"
fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
with os.fdopen(fd, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, indent=2)
    f.write("\n")
    f.flush()
    os.fsync(f.fileno())
os.chown(tmp, st.st_uid, st.st_gid)
os.replace(tmp, path)
dfd = os.open(os.path.dirname(path), os.O_RDONLY)
try:
    os.fsync(dfd)
finally:
    os.close(dfd)
PY
}

# ---------------------------------------------------------------- 1. 依存パッケージ

packages=()
while IFS= read -r line; do
    line="${line%%#*}"
    line="${line//[[:space:]]/}"
    [ -n "$line" ] && packages+=("$line")
done < "$SCRIPT_DIR/os/packages.txt"

log "依存パッケージを入れます: ${packages[*]}"
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends "${packages[@]}"

# ---------------------------------------------------------------- 2. 設定ファイルの検査

if [ -n "$config_src" ]; then
    python3 - "$config_src" <<'PY' || die "config.json の形式が不正です（apiBaseUrl・deviceToken・dataDir が必要）"
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
assert isinstance(data, dict)
for key in ("apiBaseUrl", "deviceToken", "dataDir"):
    assert data.get(key), key
assert data["dataDir"] == "/var/lib/sharehouse-signage", data["dataDir"]
PY
fi

# ---------------------------------------------------------------- 3. 表示用ユーザーと自動ログイン

if id -u "$user" >/dev/null 2>&1; then
    log "既存のユーザー $user を使います"
else
    log "ユーザー $user を作ります"
    useradd --create-home --shell /bin/bash "$user"
fi
# mpv・Chromium が GPU と音声を使えるように
for group in video render audio input; do
    if getent group "$group" >/dev/null; then
        usermod -a -G "$group" "$user"
    fi
done
uid="$(id -u "$user")"
gid="$(id -g "$user")"
home_dir="$(getent passwd "$user" | cut -d: -f6)"

# task_003: GUI 起動方式が確定したらここを固定する。現状は Bookworm 標準の Wayland（labwc）で、
#           raspi-config の非対話モードを使う（W3 = labwc、B4 = デスクトップへ自動ログイン、
#           do_blanking 1 = 画面の自動消灯を無効）。raspi-config は自動ログインの対象を
#           SUDO_USER から決めるため、表示用ユーザーを渡す。
if command -v raspi-config >/dev/null 2>&1; then
    raspi-config nonint do_wayland W3
    SUDO_USER="$user" raspi-config nonint do_boot_behaviour B4
    SUDO_USER="$user" raspi-config nonint do_blanking 1
else
    log "警告: raspi-config が無いため、自動ログインと自動消灯の設定を飛ばしました"
fi

# ---------------------------------------------------------------- 4. Agent 本体

install -d -o root -g root -m 0755 "$APP_BASE" "$RELEASES_DIR"
version="$(agent_version_of "$SCRIPT_DIR")"
release_dir="$RELEASES_DIR/$version"
if [ -d "$release_dir" ]; then
    log "Agent $version は配置済みです"
else
    log "Agent $version を $release_dir に配置します"
    stage="$(mktemp -d "$RELEASES_DIR/.stage.XXXXXX")"
    install -d -m 0755 "$stage/agent"
    install -m 0644 "$SCRIPT_DIR"/agent/*.py "$stage/agent/"
    chmod 0755 "$stage"
    sync
    mv -T "$stage" "$release_dir"
    sync "$RELEASES_DIR"
fi
old_release="$(readlink "$APP_BASE/current" 2>/dev/null || true)"
if [ "$old_release" != "$release_dir" ]; then
    if [ -n "$old_release" ]; then
        switch_link "$APP_BASE/previous" "$old_release"
    fi
    switch_link "$APP_BASE/current" "$release_dir"
fi

# ---------------------------------------------------------------- 5. データディレクトリと設定ファイル

install -d -o "$user" -g "$gid" -m 0750 "$DATA_DIR"
install -d -o root -g "$gid" -m 0750 "$ETC_DIR"
if [ -n "$config_src" ]; then
    log "設定ファイルを $CONFIG_FILE に置きます（権限 600）"
    install -o "$user" -g "$gid" -m 0600 "$config_src" "$CONFIG_FILE"
fi
chown "$user:$gid" "$CONFIG_FILE"
chmod 0600 "$CONFIG_FILE"
set_agent_version "$version"

# Chromium と labwc の autostart が読む値（ポート・画面回転）
python3 - "$CONFIG_FILE" > "$KIOSK_ENV.tmp" <<'PY'
import json, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
port = int(data.get("localServerPort", 8080))
# task_003: 縦置きの transform を 90 か 270 か実機の取り付け向きで確定する
transform = "90" if data.get("orientation") == "portrait" else "normal"
print(f"SIGNAGE_PORT={port}")
print("SIGNAGE_OUTPUT=HDMI-A-1")
print(f"SIGNAGE_TRANSFORM={transform}")
PY
chown root:"$gid" "$KIOSK_ENV.tmp"
chmod 0640 "$KIOSK_ENV.tmp"
mv -f "$KIOSK_ENV.tmp" "$KIOSK_ENV"

# ---------------------------------------------------------------- 6. 初期表示バンドル

if [ -L "$DATA_DIR/current" ]; then
    log "表示の current 世代は既にあります（初期バンドルは置きません）"
else
    [ -n "$bundle_src" ] || die "current 世代がまだ無いため --bundle（dist-display の zip）が必要です"
    log "初期表示バンドルを current 世代として置きます"
    # generations.py と同じ構成（bundles/<id>/bundle.zip、generations/<version>/{config,manifest}.json、
    # current -> generations/<version>）。config は lib/config-schema.ts を満たす最小の内容で、
    # 初回同期でサーバーの config に置き換わる。
    python3 - "$DATA_DIR" "$CONFIG_FILE" "$bundle_src" <<'PY'
import hashlib, json, os, shutil, sys
from pathlib import Path

data_dir, agent_config, bundle_src = Path(sys.argv[1]), sys.argv[2], sys.argv[3]
device = json.load(open(agent_config, encoding="utf-8"))

digest = hashlib.sha256()
with open(bundle_src, "rb") as f:
    for chunk in iter(lambda: f.read(1024 * 1024), b""):
        digest.update(chunk)
bundle_sha = digest.hexdigest()
bundle_size = os.path.getsize(bundle_src)
bundle_id = f"{bundle_sha[:12]}-initial"

def fsync_dir(path):
    fd = os.open(path, os.O_RDONLY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

def write_durably(path, data):
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)

bundle_dir = data_dir / "bundles" / bundle_id
bundle_dir.mkdir(parents=True, exist_ok=True)
tmp_zip = bundle_dir / "bundle.zip.tmp"
shutil.copyfile(bundle_src, tmp_zip)
with open(tmp_zip, "rb") as f:
    os.fsync(f.fileno())
os.replace(tmp_zip, bundle_dir / "bundle.zip")

portrait = device.get("orientation") == "portrait"
config = {
    "schemaVersion": 1,
    "events": [],
    "notices": [],
    "house": {
        "name": device.get("deviceName") or "Share House",
        "headerCopy": None,
        "footerCopy": None,
        "logo": None,
        "footerImage": None,
        "rules": [],
    },
    "schedule": [],
    "weather": None,
    "video": {"enabled": False, "intervalMinutes": 10, "mode": "sequence"},
    "playlist": [],
    "displayBundle": {"id": bundle_id, "sha256": bundle_sha, "size": bundle_size},
    "device": {
        "orientation": "portrait" if portrait else "landscape",
        "width": int(device.get("resolutionWidth") or (1080 if portrait else 1920)),
        "height": int(device.get("resolutionHeight") or (1920 if portrait else 1080)),
        "volume": 0,
    },
    "commands": {"testPlayRequestedAt": None},
}
version = hashlib.sha256(json.dumps(config, sort_keys=True).encode("utf-8")).hexdigest()
config["version"] = version

gen_dir = data_dir / "generations" / version
gen_dir.mkdir(parents=True, exist_ok=True)
write_durably(gen_dir / "config.json", config)
write_durably(
    gen_dir / "manifest.json",
    {
        "version": version,
        "entries": [
            {"kind": "bundle", "key": bundle_id, "sha256": bundle_sha, "size": bundle_size, "media_id": None}
        ],
    },
)
for d in ("media", "state"):
    (data_dir / d).mkdir(exist_ok=True)

tmp_link = data_dir / f".current.tmp.{os.getpid()}"
if tmp_link.is_symlink():
    tmp_link.unlink()
os.symlink(gen_dir, tmp_link, target_is_directory=True)
os.replace(tmp_link, data_dir / "current")
fsync_dir(data_dir)
print(f"initial generation {version} (bundle {bundle_id})")
PY
    chown -R "$user:$gid" "$DATA_DIR"
fi

# ---------------------------------------------------------------- 7. OS の設定（書き込み抑制・RTC）

log "journald を揮発・上限つきにします"
install -d -m 0755 /etc/systemd/journald.conf.d
install -m 0644 "$SCRIPT_DIR/os/journald/sharehouse-signage.conf" /etc/systemd/journald.conf.d/sharehouse-signage.conf
systemctl restart systemd-journald

log "Chromium 用の tmpfs（$KIOSK_TMPFS）を設定します"
sed -e "s/@UID@/$uid/" -e "s/@GID@/$gid/" "$SCRIPT_DIR/os/tmpfs/var-cache-kiosk.mount" > /etc/systemd/system/var-cache-kiosk.mount
chmod 0644 /etc/systemd/system/var-cache-kiosk.mount
systemctl daemon-reload
systemctl enable var-cache-kiosk.mount
# 既にマウント済みで uid が変わっていても次回起動で正しくなる。未マウントならここでマウントする
systemctl start var-cache-kiosk.mount

log "RTC（DS3231）を有効にします"
if [ -f "$BOOT_CONFIG" ]; then
    if ! grep -q '^# >>> sharehouse-signage >>>' "$BOOT_CONFIG"; then
        { printf '\n'; cat "$SCRIPT_DIR/os/boot/config.txt.snippet"; } >> "$BOOT_CONFIG"
    fi
else
    log "警告: $BOOT_CONFIG が無いため RTC の dtoverlay を追記できませんでした"
fi
if dpkg -s fake-hwclock >/dev/null 2>&1; then
    apt-get purge -y fake-hwclock
fi
# systemd 環境では udev の hwclock-set が何もせず終わるため、RTC からの時刻の読み込みを有効にする。
# task_003: Bookworm の hwclock-set の中身と、この変更で起動時に RTC の時刻が入ることを実機で確かめる。
if [ -f /lib/udev/hwclock-set ]; then
    sed -i '/^if \[ -e \/run\/systemd\/system \] ; then$/,/^fi$/ s/^/#/' /lib/udev/hwclock-set
fi

# ---------------------------------------------------------------- 8. ユーザーサービスと自動起動

log "ユーザーサービスと labwc の autostart を置きます"
install -d -o "$user" -g "$gid" -m 0755 "$home_dir/.config" "$home_dir/.config/systemd" "$home_dir/.config/systemd/user" "$home_dir/.config/labwc"
install -o "$user" -g "$gid" -m 0644 "$SCRIPT_DIR/systemd/signage-agent.service" "$home_dir/.config/systemd/user/signage-agent.service"
install -o "$user" -g "$gid" -m 0644 "$SCRIPT_DIR/systemd/chromium-kiosk.service" "$home_dir/.config/systemd/user/chromium-kiosk.service"
install -o "$user" -g "$gid" -m 0644 "$SCRIPT_DIR/os/labwc/autostart" "$home_dir/.config/labwc/autostart"
# ユーザーの systemd が動いていれば（ログイン中なら）ユニットを読み直させる
if [ -S "/run/user/$uid/systemd/private" ]; then
    systemctl --user -M "$user@" daemon-reload || true
fi

log "完了しました。Agent $version。再起動すると自動ログインして表示が始まります: sudo reboot"
