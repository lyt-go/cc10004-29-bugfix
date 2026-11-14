#!/usr/bin/env bash
# 端到端验收：打包 service+store 用 node 跑（localStorage 垫片模拟浏览器写路径）。
set -euo pipefail
cd "$(dirname "$0")/../frontend"
OUT="$(mktemp -d)/verify-e2e.mjs"
./node_modules/.bin/esbuild ../work/verify-e2e.ts --bundle --platform=node --format=esm --outfile="$OUT" >/dev/null
node "$OUT"
