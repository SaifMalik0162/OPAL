#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT_DIR"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "OPAL macOS release packaging must run on macOS." >&2
  exit 1
fi

RELEASE_MODE="${1:---unsigned}"
if [[ "$RELEASE_MODE" != "--unsigned" && "$RELEASE_MODE" != "--signed" ]]; then
  echo "usage: release-macos.sh [--unsigned|--signed]" >&2
  exit 2
fi

if [[ "$RELEASE_MODE" == "--signed" ]]; then
  : "${APPLE_SIGNING_IDENTITY:?Set APPLE_SIGNING_IDENTITY to a Developer ID Application certificate name.}"
  : "${APPLE_ID:?Set APPLE_ID for notarization.}"
  : "${APPLE_TEAM_ID:?Set APPLE_TEAM_ID for notarization.}"
  : "${APPLE_APP_PASSWORD:?Set APPLE_APP_PASSWORD to an app-specific notarytool password.}"

  if ! security find-identity -v -p codesigning | grep -Fq "$APPLE_SIGNING_IDENTITY"; then
    echo "The requested signing identity is not installed in the keychain." >&2
    exit 1
  fi
fi

npm run build
cargo test --manifest-path src-tauri/Cargo.toml
npx tauri build --bundles app --ci

APP_PATH="$(find src-tauri/target/release/bundle/macos -maxdepth 1 -name '*.app' -print -quit)"
[[ -n "$APP_PATH" && -d "$APP_PATH" ]] || { echo "Release app bundle was not created." >&2; exit 1; }

DMG_DIR="$ROOT_DIR/src-tauri/target/release/bundle/dmg"
mkdir -p "$DMG_DIR"
DMG_PATH="$DMG_DIR/OPAL-0.1.0-alpha.1-macOS-arm64.dmg"
"$ROOT_DIR/scripts/create-opal-dmg.sh" "$APP_PATH" "$DMG_PATH" "$ROOT_DIR/src-tauri/dmg/the-passage@2x.png"

if [[ "$RELEASE_MODE" == "--unsigned" ]]; then
  echo "Unsigned OPAL 0.1.0-alpha.1 test release:"
  echo "  app: $APP_PATH"
  echo "  dmg: $DMG_PATH"
  echo "  note: Gatekeeper may require Open or a manual macOS override."
  exit 0
fi

codesign --verify --deep --strict --verbose=2 "$APP_PATH"
spctl --assess --type execute --verbose=4 "$APP_PATH"
xcrun notarytool submit "$DMG_PATH" --apple-id "$APPLE_ID" --team-id "$APPLE_TEAM_ID" --password "$APPLE_APP_PASSWORD" --wait
xcrun stapler staple "$APP_PATH"
xcrun stapler staple "$DMG_PATH"
xcrun stapler validate "$APP_PATH"
xcrun stapler validate "$DMG_PATH"
spctl --assess --type open --context context:primary-signature --verbose=4 "$DMG_PATH"

echo "Signed and notarized OPAL 0.1.0-alpha.1:"
echo "  app: $APP_PATH"
echo "  dmg: $DMG_PATH"
