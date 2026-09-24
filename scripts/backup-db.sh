#!/usr/bin/env bash
#
# Turso DB を SQL ダンプし、gzip 圧縮して R2 の backups/ に保存する（task_025）。
#
# 使い方:
#   scripts/backup-db.sh [DB_NAME] [BUCKET_NAME]
#
# 既定値: DB_NAME=og-signage, BUCKET_NAME=sharehouse-signage
#
# 前提:
#   - turso CLI がログイン済み（turso auth login）で、DB_NAME を読み取れること。
#   - wrangler（npx 経由）が本アカウントで認証済みであること。
#
# R2 への書き込み先は既定で --remote（本番の R2）。ローカルでの動作確認だけ、
# 環境変数 R2_REMOTE_FLAG=--local（必要なら R2_PERSIST_TO も）を指定して上書きする。
# DB_NAME には turso dev のレプリカ URL（例: http://127.0.0.1:8080）も指定できる
# （turso db shell の仕様。ローカル動作確認用）。
#
# 例（ローカル動作確認。本番には一切触れない）:
#   R2_REMOTE_FLAG=--local R2_PERSIST_TO=/tmp/r2-local \
#     scripts/backup-db.sh http://127.0.0.1:8080 test-bucket
#
# 30 日より古いバックアップの削除は docs/runbook.md に手動手順として記載している。
# このスクリプトは削除しない。
set -euo pipefail

DB_NAME="${1:-og-signage}"
BUCKET_NAME="${2:-sharehouse-signage}"
R2_REMOTE_FLAG="${R2_REMOTE_FLAG:---remote}"

TIMESTAMP="$(date -u +%Y%m%d-%H%M%S)"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "${WORKDIR}"' EXIT

DUMP_FILE="${WORKDIR}/${TIMESTAMP}.sql"
GZ_FILE="${DUMP_FILE}.gz"
R2_KEY="backups/${DB_NAME##*/}-${TIMESTAMP}.sql.gz"

log() { printf '[backup-db] %s\n' "$*" >&2; }

log "dumping ${DB_NAME} ..."
turso db shell "${DB_NAME}" .dump >"${DUMP_FILE}"

log "compressing ..."
gzip -9 "${DUMP_FILE}"

log "uploading to r2://${BUCKET_NAME}/${R2_KEY} (${R2_REMOTE_FLAG}) ..."
r2_args=(wrangler r2 object put "${BUCKET_NAME}/${R2_KEY}" --file "${GZ_FILE}" --content-type application/gzip "${R2_REMOTE_FLAG}")
if [ "${R2_REMOTE_FLAG}" = "--local" ] && [ -n "${R2_PERSIST_TO:-}" ]; then
  r2_args+=(--persist-to "${R2_PERSIST_TO}")
fi
npx "${r2_args[@]}"

log "done: ${R2_KEY}"
