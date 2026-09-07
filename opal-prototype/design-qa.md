# OPAL — visual QA

Last checked: 2026-09-06

Status: passed on the packaged macOS build at the configured 1240 × 820 desktop size. No blocking visual issues remain.

## Checked

- Library carousel, sleeve selection, project grid, and project detail.
- Persistent player, queue, transport, progress, volume, and navigation continuity.
- Import, notes, search, empty-library recovery, sorting, and deletion states.
- Keyboard focus, reduced motion, reduced transparency, and narrow responsive layouts.
- Native macOS window chrome, integrated traffic lights, dark material, and artwork loading.

The visual system remains centred on deep plum, warm ivory, lavender glass, real square artwork, and a compact floating dock. Library stays art-led; Projects uses a quieter collection grid; project detail gives the cover and track workspace room to breathe.

## Verification

```sh
npm run build
npm run test:sites
npm run test:playback
npm run test:notes
cargo test --manifest-path src-tauri/Cargo.toml
npx tauri build --debug --no-bundle --ci
git diff --check
```

The current native build opens the persisted local library, resolves managed artwork, retains the selected track across navigation, and keeps playback state at the application level. The browser preview is intentionally read-only for managed local audio.

## Open edges

- Native import/restart still needs a final click-through with representative WAV, MP3, FLAC, AIFF, and M4A fixtures.
- Windows and Linux shell, material, packaging, and playback remain unverified.
- Developer ID signing, notarization, and a clean-account install require a normal macOS release environment with credentials.
- DMG fallback packaging is scripted but is not claimed verified on this machine.
