# OPAL

> A local-first music library with a little more atmosphere.

OPAL keeps a personal collection on the Mac and gives it a listening-room shape: sleeves, notes, a persistent queue, and playback that stays put while you move around.

This repository holds the current Tauri desktop prototype. It is an early macOS alpha. Accounts, sync, and sharing are deliberately out of scope for now.

## Run it

```sh
cd opal-prototype
npm install
npm run dev
```

For the desktop shell:

```sh
npm run tauri:dev
```

## Check it

```sh
npm run build
npm run test:sites
npm run test:playback
npm run test:waveform
npm run test:notes
cargo test --manifest-path src-tauri/Cargo.toml
```

## In the box

- Vite and React frontend
- Tauri 2 desktop shell
- SQLite projects and tracks
- Local managed audio and artwork
- Persistent queue and webview playback

The prototype boundary and visual language live in [`opal-prototype/design-contract.md`](opal-prototype/design-contract.md). Desktop architecture and platform notes are in [`opal-prototype/desktop-foundation.md`](opal-prototype/desktop-foundation.md).
