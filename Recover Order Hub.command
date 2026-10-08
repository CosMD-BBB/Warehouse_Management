#!/bin/bash
# Runs only on the owner's computer; no database or password is bundled.
set -u

RECOVERY_ROOT="$(cd -- "$(dirname -- "$0")" && pwd -P)" || exit 1
cd -- "$RECOVERY_ROOT" || exit 1

recovery_pause() {
  if [ -t 0 ]; then
    read -r -p 'กด Enter เพื่อปิดหน้าต่าง… ' RECOVERY_CLOSE
  fi
}

printf '%s\n' 'Order Hub — กู้บัญชี Admin บนเครื่องเจ้าของฐานข้อมูล' ''
RECOVERY_NODE_FOUND="$(command -v node || true)"
RECOVERY_NODE=''
for RECOVERY_CANDIDATE in "$RECOVERY_NODE_FOUND" /opt/homebrew/bin/node /usr/local/bin/node; do
  if [ -n "$RECOVERY_CANDIDATE" ] && [ -x "$RECOVERY_CANDIDATE" ]; then
    RECOVERY_MAJOR="$("$RECOVERY_CANDIDATE" -p 'process.versions.node.split(".")[0]' 2>/dev/null)" || continue
    if [ "$RECOVERY_MAJOR" = '24' ]; then
      RECOVERY_NODE="$RECOVERY_CANDIDATE"
      break
    fi
  fi
done
if [ -z "$RECOVERY_NODE" ]; then
  printf '%s\n' 'ต้องติดตั้ง Node.js 24 บนเครื่องนี้ก่อน: https://nodejs.org/en/download' 'เมื่อติดตั้งแล้ว เปิดไฟล์นี้อีกครั้ง'
  recovery_pause
  exit 1
fi

if ! "$RECOVERY_NODE" --input-type=module -e 'await import("pg")' >/dev/null 2>&1; then
  RECOVERY_NPM_FOUND="$(command -v npm || true)"
  RECOVERY_NPM=''
  for RECOVERY_CANDIDATE in "$RECOVERY_NPM_FOUND" "$(dirname -- "$RECOVERY_NODE")/npm" /opt/homebrew/bin/npm /usr/local/bin/npm; do
    if [ -n "$RECOVERY_CANDIDATE" ] && [ -f "$RECOVERY_CANDIDATE" ]; then
      RECOVERY_NPM="$RECOVERY_CANDIDATE"
      break
    fi
  done
  if [ -z "$RECOVERY_NPM" ]; then
    printf '%s\n' 'ไม่พบ npm ที่มากับ Node.js 24 กรุณาติดตั้ง Node.js 24 ให้ครบก่อนเปิดไฟล์นี้อีกครั้ง'
    recovery_pause
    exit 1
  fi
  printf '%s\n' 'กำลังติดตั้งตัวเชื่อม PostgreSQL ตาม package-lock ของโปรเจกต์…'
  "$RECOVERY_NODE" "$RECOVERY_NPM" ci --ignore-scripts --no-audit --no-fund
  RECOVERY_INSTALL_STATUS=$?
  if [ "$RECOVERY_INSTALL_STATUS" -ne 0 ]; then
    printf '%s\n' 'ติดตั้งตัวเชื่อมฐานข้อมูลไม่สำเร็จ ยังไม่ได้เปลี่ยนบัญชี'
    recovery_pause
    exit "$RECOVERY_INSTALL_STATUS"
  fi
fi

"$RECOVERY_NODE" scripts/recover-owner-wizard.mjs "$@"
RECOVERY_STATUS=$?
recovery_pause
exit "$RECOVERY_STATUS"
