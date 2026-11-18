#!/usr/bin/env bash
# dsh-tts 安装 / 卸载（Linux / macOS）。需要 node 在 PATH 上。
#
#   ./一键安装.sh            安装
#   ./一键安装.sh --uninstall 卸载
#   ./一键安装.sh --dry-run   只看要改什么
set -euo pipefail
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "找不到 node，请先安装 Node.js 或把它加进 PATH" >&2
  exit 1
fi
exec node scripts/install.mjs "$@"
