#!/bin/bash
# 一键把 ReadMark 转成 Safari 插件并编译安装（需要 macOS + Xcode）
#
# 用法：
#   bash safari/build-safari.sh               # 本地签名（需在 Safari 中允许未签名扩展）
#   TEAM_ID=ABCDE12345 bash safari/build-safari.sh   # 用你的 Apple ID 开发团队签名（推荐，重启 Safari 后不用重新允许）
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
EXT_DIR="$(dirname "${HERE}")"
OUT_DIR="${OUT_DIR:-${HOME}/ReadMark-Safari}"
APP_NAME="ReadMark"
BUNDLE_ID="${BUNDLE_ID:-com.readmark.ReadMark}"

if ! xcrun --find safari-web-extension-converter >/dev/null 2>&1; then
  echo "❌ 没找到 safari-web-extension-converter。请确认已安装 Xcode，并执行："
  echo "   sudo xcode-select -s /Applications/Xcode.app/Contents/Developer"
  exit 1
fi

# 只把插件本身的文件交给转换工具（不含 safari/ 目录和说明文档）
STAGE="$(mktemp -d)/readmark"
mkdir -p "${STAGE}"
cp -R "${EXT_DIR}/manifest.json" "${EXT_DIR}/src" "${EXT_DIR}/popup" "${EXT_DIR}/options" "${EXT_DIR}/icons" "${STAGE}/"

echo "▶ 1/3 生成 Xcode 工程：${OUT_DIR}"
rm -rf "${OUT_DIR}"
xcrun safari-web-extension-converter "${STAGE}" \
  --project-location "${OUT_DIR}" \
  --app-name "${APP_NAME}" \
  --bundle-identifier "${BUNDLE_ID}" \
  --macos-only --swift --copy-resources \
  --no-open --no-prompt --force

PROJ="$(find "${OUT_DIR}" -maxdepth 2 -name '*.xcodeproj' | head -1)"
SCHEME="$(xcodebuild -list -project "${PROJ}" 2>/dev/null | awk '/Schemes:/{f=1;next} f&&NF{print;exit}' | sed 's/^ *//')"

if [ -z "${SCHEME}" ]; then SCHEME="${APP_NAME}"; fi

echo "▶ 2/3 编译（scheme: ${SCHEME}）"
SIGN_ARGS=(CODE_SIGN_IDENTITY="-" CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM="" PROVISIONING_PROFILE_SPECIFIER="")
if [ -n "${TEAM_ID:-}" ]; then
  SIGN_ARGS=(DEVELOPMENT_TEAM="${TEAM_ID}" CODE_SIGN_STYLE=Automatic -allowProvisioningUpdates)
fi
xcodebuild -project "${PROJ}" -scheme "${SCHEME}" -configuration Release \
  -derivedDataPath "${OUT_DIR}/build" "${SIGN_ARGS[@]}" build 2>&1 | grep -E "error:|BUILD (SUCCEEDED|FAILED)" | grep -v "DVT\|CoreSimulator\|CoreDevice" || true

APP="$(find "${OUT_DIR}/build/Build/Products/Release" -maxdepth 1 -name '*.app' | head -1)"
if [ -z "${APP}" ]; then
  echo "❌ 编译失败。可以先执行 sudo xcodebuild -runFirstLaunch 修复 Xcode 组件后重试；"
  echo "   或者打开 ${PROJ} ，在 Signing & Capabilities 里选择你的 Team 后点 ▶ 运行。"
  exit 1
fi

echo "▶ 3/3 安装到 ~/Applications 并启动一次（让 Safari 识别插件）"
mkdir -p "${HOME}/Applications"
rm -rf "${HOME}/Applications/${APP_NAME}.app"
cp -R "${APP}" "${HOME}/Applications/"
# 删掉编译目录里的那份 App，避免 Safari 里出现两个 ReadMark
LSREG=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
[ -x "${LSREG}" ] && "${LSREG}" -u "${APP}" >/dev/null 2>&1 || true
rm -rf "${APP}"
open "${HOME}/Applications/${APP_NAME}.app"

cat <<MSG

✅ 完成！接下来在 Safari 里：
  1. Safari → 设置 → 高级：勾选「显示网页开发者功能」
$( [ -z "${TEAM_ID:-}" ] && echo "  2. Safari → 设置 → 开发者：勾选「允许未签名的扩展」（每次重启 Safari 后需要重新勾选）" || echo "  2. （已用你的团队签名，无需允许未签名扩展）" )
  3. Safari → 设置 → 扩展：勾选 ReadMark，点「编辑网站…」把「其他网站」设为「允许」
  4. 刷新网页，选中文字试试

以后更新了插件代码，重新运行本脚本即可。
MSG
