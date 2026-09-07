# OPAL 0.1.0-alpha.1 macOS installer

This is the unsigned local-only macOS alpha installer for OPAL. The DMG uses the “The Passage” presentation and is intended for internal testing; Gatekeeper may require the Finder Open override.

## Build

```sh
npm run release:macos:unsigned
```

The resulting installer is:

`src-tauri/target/release/bundle/dmg/OPAL-0.1.0-alpha.1-macOS-arm64.dmg`

The signed command remains available as `npm run release:macos` for a host with the required Developer ID and notarization credentials.

## Verified on this Mac

- The authoritative `OPAL.icon` source is preserved in `brand-assets/OPAL.icon/`.
- The generated ICNS round-trips through `iconutil`; the ICO contains 16, 32, 64, 128, and 256 pixel PNG entries.
- The bundled app reports product name `OPAL`, bundle identifier `com.opal.library`, and version `0.1.0-alpha.1`.
- The mounted DMG presents only `OPAL.app` and the Applications alias in icon view.
- Finder renders the 1440 x 960 Retina background in a 720 x 480 installer window, with the two real icons placed at the configured positions.
- The Applications alias opens the real Applications folder.
- OPAL was copied into `/Applications` during the installer check and the installed Release app launched successfully.
- Ejecting and remounting the final DMG preserved the background, icon view, positions, and volume contents.
- Frontend production build and the Rust test suite pass as part of the release command.

## Screenshot

[Mounted DMG screenshot](./opal-dmg-mounted.png)

## Remaining limitation

This artifact is unsigned and not notarized. Windows and Linux packaging remain unvalidated targets.
