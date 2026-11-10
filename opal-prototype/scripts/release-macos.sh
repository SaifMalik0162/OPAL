#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "OPAL macOS candidate packaging must run on macOS." >&2
  exit 1
fi

RELEASE_MODE="${1:---unsigned}"
if [[ "$RELEASE_MODE" != "--unsigned" && "$RELEASE_MODE" != "--signed" && "$RELEASE_MODE" != "--signed-validation" ]]; then
  echo "usage: release-macos.sh [--unsigned|--signed|--signed-validation]" >&2
  exit 2
fi

IS_SIGNED=0
IS_NOTARIZED=0
if [[ "$RELEASE_MODE" == "--signed" || "$RELEASE_MODE" == "--signed-validation" ]]; then
  IS_SIGNED=1
fi
if [[ "$RELEASE_MODE" == "--signed" ]]; then
  IS_NOTARIZED=1
fi

VERSION="$(node -p 'require("./package.json").version')"
export OPAL_BUILD_COMMIT="${OPAL_BUILD_COMMIT:-$(git rev-parse HEAD)}"
export VITE_OPAL_BUILD_COMMIT="$OPAL_BUILD_COMMIT"
npm run check:release
if [[ "${OPAL_SKIP_VERIFY:-0}" != "1" ]]; then
  npm run verify
fi

rustup target add aarch64-apple-darwin x86_64-apple-darwin

if [[ "$IS_SIGNED" == "1" ]]; then
  : "${APPLE_SIGNING_IDENTITY:?Set APPLE_SIGNING_IDENTITY to a Developer ID Application certificate name.}"
  : "${TAURI_SIGNING_PRIVATE_KEY:?Set TAURI_SIGNING_PRIVATE_KEY for signed updater artifacts.}"
fi
if [[ "$IS_NOTARIZED" == "1" ]]; then
  : "${APPLE_ID:?Set APPLE_ID for notarization.}"
  : "${APPLE_TEAM_ID:?Set APPLE_TEAM_ID for notarization.}"
  : "${APPLE_APP_PASSWORD:?Set APPLE_APP_PASSWORD to an app-specific notarytool password.}"
fi

if [[ "$IS_SIGNED" == "1" ]]; then
  if ! security find-identity -v -p codesigning | grep -Fq "$APPLE_SIGNING_IDENTITY"; then
    echo "The requested signing identity is not installed in the keychain." >&2
    exit 1
  fi
fi

BUILD_ARGS=(build --target universal-apple-darwin --bundles app --ci)
if [[ "$IS_SIGNED" == "0" ]]; then
  BUILD_ARGS+=(--no-sign)
else
  BUILD_ARGS+=(--config src-tauri/tauri.updater.conf.json)
fi
npm run tauri -- "${BUILD_ARGS[@]}"

APP_PATH="$ROOT_DIR/src-tauri/target/universal-apple-darwin/release/bundle/macos/OPAL.app"
[[ -d "$APP_PATH" ]] || { echo "Universal OPAL.app was not created: $APP_PATH" >&2; exit 1; }
INFO_PLIST="$APP_PATH/Contents/Info.plist"
plutil -lint "$INFO_PLIST"
APP_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' "$INFO_PLIST")"
[[ "$APP_VERSION" == "$VERSION" ]] || { echo "Bundle version $APP_VERSION does not match $VERSION." >&2; exit 1; }
EXECUTABLE="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$INFO_PLIST")"
ARCHITECTURES="$(lipo -archs "$APP_PATH/Contents/MacOS/$EXECUTABLE")"
[[ " $ARCHITECTURES " == *" arm64 "* && " $ARCHITECTURES " == *" x86_64 "* ]] || {
  echo "Expected a universal arm64+x86_64 executable, got: $ARCHITECTURES" >&2
  exit 1
}

if [[ "$IS_SIGNED" == "1" ]]; then
  codesign --verify --deep --strict --verbose=2 "$APP_PATH"
else
  SIGNATURE_INFO="$(codesign -dv --verbose=2 "$APP_PATH" 2>&1 || true)"
  if printf '%s' "$SIGNATURE_INFO" | grep -Fq 'Authority='; then
    echo "Unsigned candidate unexpectedly carries an identity signature." >&2
    exit 1
  fi
  echo "Bundle signature inspection: unsigned local review candidate."
fi

ARTIFACT_DIR="$ROOT_DIR/artifacts/release/$VERSION/macos-universal"
mkdir -p "$ARTIFACT_DIR"
DMG_PATH="$ARTIFACT_DIR/OPAL-$VERSION-macos-universal.dmg"

if [[ "$IS_NOTARIZED" == "1" ]]; then
  APP_ZIP="$ARTIFACT_DIR/OPAL-$VERSION-macos-universal-app.zip"
  ditto -c -k --sequesterRsrc --keepParent "$APP_PATH" "$APP_ZIP"
  xcrun notarytool submit "$APP_ZIP" --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_PASSWORD" --wait
  xcrun stapler staple "$APP_PATH"
  xcrun stapler validate "$APP_PATH"
fi

if [[ "$IS_SIGNED" == "1" ]]; then
  UPDATE_ARCHIVE="$APP_PATH.tar.gz"
  rm -f "$UPDATE_ARCHIVE" "$UPDATE_ARCHIVE.sig"
  tar -czf "$UPDATE_ARCHIVE" -C "$(dirname "$APP_PATH")" "$(basename "$APP_PATH")"
  npm run tauri -- signer sign "$UPDATE_ARCHIVE"
  cp "$UPDATE_ARCHIVE" "$ARTIFACT_DIR/OPAL-$VERSION-macos-universal.app.tar.gz"
  cp "$UPDATE_ARCHIVE.sig" "$ARTIFACT_DIR/OPAL-$VERSION-macos-universal.app.tar.gz.sig"
fi

"$ROOT_DIR/scripts/create-opal-dmg.sh" "$APP_PATH" "$DMG_PATH" "$ROOT_DIR/src-tauri/dmg/the-passage@2x.png"

if [[ "$IS_NOTARIZED" == "1" ]]; then
  xcrun notarytool submit "$DMG_PATH" --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_PASSWORD" --wait
  xcrun stapler staple "$DMG_PATH"
  xcrun stapler validate "$DMG_PATH"
fi

MOUNT_POINT="$(mktemp -d -t opal-alpha-review.XXXXXX)"
cleanup() {
  hdiutil detach "$MOUNT_POINT" -force >/dev/null 2>&1 || true
  rmdir "$MOUNT_POINT" >/dev/null 2>&1 || true
}
trap cleanup EXIT
hdiutil attach "$DMG_PATH" -mountpoint "$MOUNT_POINT" -nobrowse -noautoopen -readonly >/dev/null
DMG_APP="$MOUNT_POINT/OPAL.app"
[[ -d "$DMG_APP" ]] || { echo "Final DMG does not contain OPAL.app." >&2; exit 1; }
plutil -lint "$DMG_APP/Contents/Info.plist"
DMG_ARCHITECTURES="$(lipo -archs "$DMG_APP/Contents/MacOS/$EXECUTABLE")"
[[ " $DMG_ARCHITECTURES " == *" arm64 "* && " $DMG_ARCHITECTURES " == *" x86_64 "* ]] || {
  echo "App inside the final DMG is not universal: $DMG_ARCHITECTURES" >&2
  exit 1
}

if [[ "$IS_SIGNED" == "1" ]]; then
  codesign --verify --deep --strict --verbose=2 "$DMG_APP"
  if [[ "$IS_NOTARIZED" == "1" ]]; then
    xcrun stapler validate "$DMG_APP"
    spctl --assess --type execute --verbose=4 "$DMG_APP"
    xcrun stapler validate "$DMG_PATH"
    spctl --assess --type open --context context:primary-signature --verbose=4 "$DMG_PATH"
  else
    echo "Gatekeeper notarization checks skipped for signing-only validation."
  fi
else
  echo "Final DMG inspection: OPAL.app, version $APP_VERSION, architectures $DMG_ARCHITECTURES."
fi

node scripts/write-build-manifest.mjs \
  --output-dir "$ARTIFACT_DIR" \
  --artifact "$DMG_PATH" \
  --platform macos \
  --architecture universal-arm64-x86_64 \
  --target universal-apple-darwin

echo "OPAL $VERSION macOS $RELEASE_MODE candidate: $DMG_PATH"
