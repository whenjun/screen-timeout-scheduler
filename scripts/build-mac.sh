#!/usr/bin/env bash
set -euo pipefail

# 原生工具和图标必须在 macOS 上生成，再交给 electron-builder 打包。
if [[ "$(uname -s)" != "Darwin" ]]; then
  echo 'macOS 安装包必须在 Mac 或 macOS CI 运行器上构建' >&2
  exit 1
fi

node scripts/gen-icons.js --mac
mkdir -p build/mac/icon.iconset
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" build/mac/icon.png --out "build/mac/icon.iconset/icon_${size}x${size}.png" >/dev/null
  doubled=$((size * 2))
  sips -z "$doubled" "$doubled" build/mac/icon.png --out "build/mac/icon.iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil --convert icns build/mac/icon.iconset --output build/icon.icns

xcrun --sdk macosx clang -fobjc-arc -O2 \
  -arch x86_64 -arch arm64 -mmacosx-version-min=13.0 \
  -framework Foundation -framework Security -framework IOKit \
  mac/native/screen-timeout-helper.m -o build/mac/screen-timeout-helper

# 本地和 CI 可用临时签名检查打包结构；正式分发需 Developer ID 与公证凭据。
if [[ "${MAC_UNSIGNED:-0}" == '1' ]]; then
  npx electron-builder --mac dmg --universal -c.mac.identity=- -c.mac.notarize=false
else
  npx electron-builder --mac dmg --universal
fi
