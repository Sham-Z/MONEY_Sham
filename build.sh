#!/bin/sh
set -eu

# 纯 Node.js 应用，无第三方运行时依赖，直接拷贝运行文件到 dist/
rm -rf dist
mkdir -p dist
cp server.js package.json dist/
cp -R lib public dist/
cp run.sh dist/
chmod 755 dist/run.sh
