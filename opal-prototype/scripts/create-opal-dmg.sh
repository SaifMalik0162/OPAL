#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "OPAL DMG packaging must run on macOS." >&2
  exit 1
fi

if [[ $# -ne 3 ]]; then
  echo "usage: create-opal-dmg.sh <opal-app> <output-dmg> <background-png>" >&2
  exit 2
fi

APP_PATH="$(cd "$(dirname "$1")" && pwd)/$(basename "$1")"
DMG_PATH="$2"
BACKGROUND_PATH="$(cd "$(dirname "$3")" && pwd)/$(basename "$3")"

[[ -d "$APP_PATH" ]] || { echo "OPAL app bundle not found: $APP_PATH" >&2; exit 1; }
[[ -f "$BACKGROUND_PATH" ]] || { echo "DMG background not found: $BACKGROUND_PATH" >&2; exit 1; }

DMG_DIR="$(dirname "$DMG_PATH")"
mkdir -p "$DMG_DIR"

STAGING_DIR="$(mktemp -d -t opal-dmg-staging.XXXXXX)"
RW_DMG="$(mktemp -t opal-dmg-rw.XXXXXX).dmg"
MOUNT_POINT="$(mktemp -d -t opal-dmg-mount.XXXXXX)"
TEMP_VOLUME_NAME="OPAL-Layout-$$"
MOUNTED=0

cleanup() {
  if [[ "$MOUNTED" -eq 1 ]]; then
    hdiutil detach "$MOUNT_POINT" -force >/dev/null 2>&1 || true
  fi
  rm -rf "$STAGING_DIR" "$MOUNT_POINT" "$RW_DMG"
}
trap cleanup EXIT

mkdir -p "$STAGING_DIR/.background"
cp -R "$APP_PATH" "$STAGING_DIR/OPAL.app"
cp "$BACKGROUND_PATH" "$STAGING_DIR/.background/background.png"
ln -s /Applications "$STAGING_DIR/Applications"

hdiutil create \
  -volname "$TEMP_VOLUME_NAME" \
  -srcfolder "$STAGING_DIR" \
  -fs HFS+ \
  -format UDRW \
  -ov \
  "$RW_DMG" >/dev/null

hdiutil attach "$RW_DMG" \
  -mountpoint "$MOUNT_POINT" \
  -nobrowse \
  -noautoopen >/dev/null
MOUNTED=1

# Finder writes the icon-view metadata into the mounted image. Every value is
# set here on every build, so the visual layout is reproducible and does not
# depend on a previously saved Finder window.
osascript - "$MOUNT_POINT" <<'APPLESCRIPT'
on run argv
    set mountPath to item 1 of argv
    tell application "Finder"
        set volumeAlias to POSIX file mountPath as alias
        open volumeAlias
        delay 0.6
        set volumeWindow to front Finder window
        try
            set toolbar visible of volumeWindow to false
        end try
        try
            set statusbar visible of volumeWindow to false
        end try
        try
            set pathbar visible of volumeWindow to false
        end try
        set current view of volumeWindow to icon view
        set bounds of volumeWindow to {100, 100, 820, 580}
        set viewOptions to icon view options of volumeWindow
        set arrangement of viewOptions to not arranged
        set icon size of viewOptions to 128
        try
            set background picture of viewOptions to POSIX file (mountPath & "/.background/background.png") as alias
        end try
        set position of item "OPAL.app" of volumeWindow to {180, 240}
        set position of item "Applications" of volumeWindow to {540, 240}
        delay 0.6
        close volumeWindow
    end tell
end run
APPLESCRIPT

diskutil rename "$MOUNT_POINT" "OPAL" >/dev/null
hdiutil detach "$MOUNT_POINT" >/dev/null
MOUNTED=0

rm -f "$DMG_PATH"
hdiutil convert "$RW_DMG" \
  -format UDZO \
  -imagekey zlib-level=9 \
  -ov \
  -o "$DMG_PATH" >/dev/null

[[ -f "$DMG_PATH" ]] || { echo "OPAL DMG was not created." >&2; exit 1; }
echo "$DMG_PATH"
