#!/usr/bin/env bash
# 等价于 ./一键安装.sh --uninstall
set -euo pipefail
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo "找不到 node，请先安装 Node.js 或把它加进 PATH" >&2
  exit 1
fi
exec node scripts/install.mjs --uninstall "$@"
