# OPAL 0.1.0-alpha.1 — macOS installer

An unsigned, local-only macOS alpha for internal testing. Gatekeeper may require the Finder Open override.

## Build

```sh
npm run release:macos:unsigned
```

Output:

`src-tauri/target/release/bundle/dmg/OPAL-0.1.0-alpha.1-macOS-arm64.dmg`

The signed path remains available as `npm run release:macos` on a machine with a Developer ID certificate and notarization credentials.

## Release checks

The bundle uses product name `OPAL`, identifier `com.opal.library`, version `0.1.0-alpha.1`, the `The Passage` DMG presentation, and the generated OPAL icon set. The mounted image contains `OPAL.app` and an Applications alias in the configured icon layout.

The frontend build and Rust test suite run as part of the release command. The mounted-DMG capture is kept beside this note for local reference.

## Limits

This artifact is unsigned and not notarized. Windows and Linux packaging remain open validation targets.
