#!/usr/bin/env bash
# 用仓库已安装的 esbuild 把验收脚本打包成临时 mjs 再用 node 运行（不污染源码、不参与前端构建）。
set -euo pipefail
cd "$(dirname "$0")/../frontend"
OUT="$(mktemp -d)/verify-domain.mjs"
./node_modules/.bin/esbuild ../work/verify-domain.ts --bundle --platform=node --format=esm --outfile="$OUT" >/dev/null
node "$OUT"
