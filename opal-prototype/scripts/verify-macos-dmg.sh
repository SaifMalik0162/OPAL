#!/usr/bin/env bash
set -euo pipefail

if [[ "${CI:-}" != "true" ]]; then
  echo "Downloaded-app first-launch verification must run in a clean CI user profile." >&2
  exit 1
fi

if [[ $# -ne 1 ]]; then
  echo "usage: verify-macos-dmg.sh <downloaded-dmg>" >&2
  exit 2
fi

DMG_PATH="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
ARTIFACT_DIR="$(dirname "$DMG_PATH")"
[[ -f "$ARTIFACT_DIR/SHA256SUMS" ]] || { echo "Build checksum manifest is missing." >&2; exit 1; }
(cd "$ARTIFACT_DIR" && shasum -a 256 -c SHA256SUMS)

APP_PATH="/Applications/OPAL Alpha2 Verification.app"
[[ ! -e "$APP_PATH" ]] || { echo "Refusing to overwrite an existing verification app." >&2; exit 1; }
MOUNT_POINT="$(mktemp -d -t opal-downloaded-dmg.XXXXXX)"
MOUNTED=0
cleanup() {
  if [[ "$MOUNTED" -eq 1 ]]; then hdiutil detach "$MOUNT_POINT" -force >/dev/null 2>&1 || true; fi
  if [[ -n "${APP_EXECUTABLE_PATH:-}" ]]; then
    pids="$(ps -A -o pid=,command= | awk -v prefix="$APP_EXECUTABLE_PATH" 'index($0, prefix) {print $1}')"
    if [[ -n "$pids" ]]; then kill $pids >/dev/null 2>&1 || true; fi
  fi
  rm -rf "$MOUNT_POINT" "$APP_PATH"
}
trap cleanup EXIT

hdiutil attach "$DMG_PATH" -mountpoint "$MOUNT_POINT" -nobrowse -noautoopen -readonly >/dev/null
MOUNTED=1
[[ -d "$MOUNT_POINT/OPAL.app" ]] || { echo "Downloaded DMG does not contain OPAL.app." >&2; exit 1; }
ditto "$MOUNT_POINT/OPAL.app" "$APP_PATH"
APP_EXECUTABLE="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$APP_PATH/Contents/Info.plist")"
APP_EXECUTABLE_PATH="$APP_PATH/Contents/MacOS/$APP_EXECUTABLE"
[[ -x "$APP_EXECUTABLE_PATH" ]] || { echo "Installed OPAL executable is missing." >&2; exit 1; }

open -n "$APP_PATH"
for attempt in {1..30}; do
  if pgrep -f "$APP_EXECUTABLE_PATH" >/dev/null; then break; fi
  sleep 1
done
pgrep -f "$APP_EXECUTABLE_PATH" >/dev/null || { echo "OPAL did not stay open after the downloaded DMG install." >&2; exit 1; }

LIBRARY_DB="$HOME/Library/Application Support/com.opal.library/opal.sqlite"
for attempt in {1..20}; do
  [[ -f "$LIBRARY_DB" ]] && break
  sleep 1
done
[[ -f "$LIBRARY_DB" ]] || { echo "First launch did not create a library database." >&2; exit 1; }
echo "Downloaded DMG checksum, Applications copy, and first launch passed."
