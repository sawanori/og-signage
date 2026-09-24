#!/usr/bin/env bash
# Share House Signage: Agent 本体の更新と、直前の版への戻し。
#
# 使い方（Pi 上で、新しい版の raspberry-pi/ ディレクトリを置いた状態で）:
#   sudo ./update.sh                  このディレクトリの agent/ を新しい版として入れる
#   sudo ./update.sh --source DIR     DIR/agent/ を新しい版として入れる
#   sudo ./update.sh --rollback       /opt/sharehouse-signage/previous の版へ戻す
#
#   --timeout 秒   localhost の応答を待つ上限（既定 120）
#   --stable 秒    応答後、再起動せずに動き続けることを確かめる時間（既定 30）
#
# 手順: releases/<version>/ に展開 → current を付け替え（親ディレクトリを fsync）→
#       signage-agent を再起動 → 生存確認。失敗したら直前の版へ戻して再起動する。
# 終了コード: 0 = 成功、1 = 生存確認に失敗して直前の版へ戻した、2 = 戻した版も生存確認に失敗。
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

APP_BASE=/opt/sharehouse-signage
RELEASES_DIR="$APP_BASE/releases"
DATA_DIR=/var/lib/sharehouse-signage
CONFIG_FILE=/etc/sharehouse-signage/agent.json
KIOSK_ENV=/etc/sharehouse-signage/kiosk.env
UNIT=signage-agent.service

source_dir="$SCRIPT_DIR"
mode="update"
timeout_s=120
stable_s=30

log() { printf '[update] %s\n' "$*"; }
die() { printf '[update] エラー: %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
    case "$1" in
        --source) source_dir="${2:-}"; shift 2 ;;
        --rollback) mode="rollback"; shift ;;
        --timeout) timeout_s="${2:-}"; shift 2 ;;
        --stable) stable_s="${2:-}"; shift 2 ;;
        -h|--help) sed -n '4,15p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
        *) die "不明な引数: $1" ;;
    esac
done

[ "$(id -u)" -eq 0 ] || die "root で実行してください（sudo ./update.sh ...）"
[ -L "$APP_BASE/current" ] || die "$APP_BASE/current がありません。先に install.sh を実行してください"
[ -f "$KIOSK_ENV" ] || die "$KIOSK_ENV がありません。先に install.sh を実行してください"

user="$(stat -c %U "$DATA_DIR")"
# shellcheck source=/dev/null
. "$KIOSK_ENV"
port="${SIGNAGE_PORT:-8080}"

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

# Agent 本体（agent/*.py）の内容から版を決める（install.sh と同じ規則）
agent_version_of() {
    (cd "$1" && find agent -maxdepth 1 -type f -name '*.py' | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -c1-12)
}

# agent.json の agentVersion を書き換える（install.sh と同じ処理。権限と所有者は保つ）
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

# 表示用ユーザーの systemd（ユーザーサービス）を root から操作する
user_systemctl() {
    systemctl --user -M "$user@" "$@"
}

http_responds() {
    local code
    code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 "http://127.0.0.1:$port/local/config.json" || true)"
    [ -n "$code" ] && [ "$code" != "000" ]
}

# 生存確認。
#   1) --timeout 秒以内に localhost のローカルサーバーが HTTP で応答する
#   2) その後 --stable 秒のあいだ、サービスが active のまま MainPID も再起動回数も変わらない
#   3) 再起動以降の Agent のログに Heartbeat スレッドの例外（heartbeat loop iteration failed）や
#      Traceback が出ていない
# heartbeat.py は送信成功をログに出さないため、「Heartbeat が1回成功したこと」は確かめられない。
# ネット切断中の Pi でも更新できるよう、送信失敗（ネットワーク不通）は失敗扱いにしない。
verify_alive() {
    local since="$1"
    local deadline=$(( $(date +%s) + timeout_s ))
    until http_responds; do
        if [ "$(date +%s)" -ge "$deadline" ]; then
            log "localhost:$port が ${timeout_s} 秒以内に応答しませんでした"
            return 1
        fi
        sleep 2
    done

    local pid restarts
    pid="$(user_systemctl show -p MainPID --value "$UNIT")"
    restarts="$(user_systemctl show -p NRestarts --value "$UNIT")"
    local stable_until=$(( $(date +%s) + stable_s ))
    while [ "$(date +%s)" -lt "$stable_until" ]; do
        sleep 2
        if ! user_systemctl is-active --quiet "$UNIT" \
            || [ "$(user_systemctl show -p MainPID --value "$UNIT")" != "$pid" ] \
            || [ "$(user_systemctl show -p NRestarts --value "$UNIT")" != "$restarts" ]; then
            log "Agent が ${stable_s} 秒のあいだ動き続けませんでした"
            return 1
        fi
    done

    if journalctl --no-pager -o cat --since "@$since" "_SYSTEMD_USER_UNIT=$UNIT" \
        | grep -E 'heartbeat loop iteration failed|Traceback' >/dev/null; then
        log "Agent のログに例外が出ています（journalctl _SYSTEMD_USER_UNIT=$UNIT で確認してください）"
        return 1
    fi
    return 0
}

restart_and_verify() {
    local since
    since="$(date +%s)"
    user_systemctl restart "$UNIT"
    verify_alive "$since"
}

# ---------------------------------------------------------------- 戻し（--rollback）

old_release="$(readlink "$APP_BASE/current")"
old_previous="$(readlink "$APP_BASE/previous" 2>/dev/null || true)"

if [ "$mode" = "rollback" ]; then
    if [ -z "$old_previous" ] || [ ! -d "$old_previous" ]; then
        die "戻す版（$APP_BASE/previous）がありません"
    fi
    log "$(basename "$old_release") から $(basename "$old_previous") へ戻します"
    switch_link "$APP_BASE/current" "$old_previous"
    switch_link "$APP_BASE/previous" "$old_release"
    set_agent_version "$(basename "$old_previous")"
    if restart_and_verify; then
        log "戻しました: $(basename "$old_previous")"
        exit 0
    fi
    log "戻した版も生存確認に失敗しました。journalctl _SYSTEMD_USER_UNIT=$UNIT を確認してください"
    exit 2
fi

# ---------------------------------------------------------------- 更新

[ -d "$source_dir/agent" ] || die "$source_dir/agent がありません"
version="$(agent_version_of "$source_dir")"
release_dir="$RELEASES_DIR/$version"

if [ "$old_release" = "$release_dir" ]; then
    log "Agent $version は既に current です"
    exit 0
fi

if [ ! -d "$release_dir" ]; then
    log "Agent $version を $release_dir に展開します"
    stage="$(mktemp -d "$RELEASES_DIR/.stage.XXXXXX")"
    install -d -m 0755 "$stage/agent"
    install -m 0644 "$source_dir"/agent/*.py "$stage/agent/"
    chmod 0755 "$stage"
    sync
    mv -T "$stage" "$release_dir"
    sync "$RELEASES_DIR"
fi

log "current を $(basename "$old_release") から $version に付け替えます"
switch_link "$APP_BASE/previous" "$old_release"
switch_link "$APP_BASE/current" "$release_dir"
set_agent_version "$version"

if restart_and_verify; then
    log "更新しました: $version（戻すときは sudo ./update.sh --rollback）"
    exit 0
fi

log "生存確認に失敗したため $(basename "$old_release") へ戻します"
switch_link "$APP_BASE/current" "$old_release"
if [ -n "$old_previous" ]; then
    switch_link "$APP_BASE/previous" "$old_previous"
fi
set_agent_version "$(basename "$old_release")"
if restart_and_verify; then
    log "$(basename "$old_release") へ戻しました（$version は releases/ に残してあります）"
    exit 1
fi
log "戻した版も生存確認に失敗しました。journalctl _SYSTEMD_USER_UNIT=$UNIT を確認してください"
exit 2
