# OPAL — desktop foundation

OPAL is a Tauri 2 application around a React/Vite interface. The shell owns the window; the library, audio, artwork, and notes stay local. Accounts, cloud sync, and sharing are not part of this build.

## Window and material

- Default window: 1240 × 820 logical pixels.
- Minimum window: 980 × 620.
- Resizable, centred, decorated, and not fullscreen by default.
- macOS uses an overlay title bar with integrated traffic lights and a deep drag region that leaves controls and inputs interactive.
- macOS attempts native Liquid Glass, then AppKit HUD vibrancy. Windows attempts Mica, Acrylic, then blur. Linux keeps the CSS fallback.
- Reduced transparency removes blur and uses an opaque deep-plum surface.

## Local library

OPAL stores a versioned SQLite database as `opal.sqlite` in the platform app-data directory. Projects and tracks have stable IDs, ordered tracks, duration and format metadata, managed-file references, source hashes, and local notes.

Managed audio lives under `audio/<project-id>/`; artwork lives under `artwork/<project-id>/`. Imports copy into a staging directory, commit their database records, and clean only the exact staging path. Original source files are never edited or removed. Startup recovery removes abandoned staging content after database checks.

Supported import choices are WAV, MP3, FLAC, AIFF/AIF, M4A, PNG, JPG/JPEG, and WEBP. Metadata is best-effort; unreadable metadata falls back to the filename while preserving the original bytes.

## Playback

One application-level `HTMLAudioElement` owns the current source, queue, position, duration, volume, mute state, and transient errors. Navigation changes the selected view, not the player. Managed audio resolves through Tauri’s scoped asset protocol.

The queue follows saved project order. Previous, next, seek, repeat, shuffle, mute, volume, and queue selection are wired to the same controller. Stale playback events are ignored, the last track is remembered, and relaunch stays paused.

## Native command surface

The frontend and Rust shell use explicit camelCase commands:

`listProjects`, `createProject`, `updateProject`, `setProjectArtwork`, `removeProjectArtwork`, `importAudioFiles`, `updateTrackTitle`, `reorderTracks`, `saveNote`, `deleteTrack`, and `deleteProject`.

Payload keys follow the same convention, including `projectId`, `trackId`, `sourcePath`, `allowDuplicates`, and `trackIds`.

## Data protection

Notes keep a local pending journal until the matching draft saves successfully. A newer draft cannot be overwritten by an older response. Deletion commits the record first; managed-file cleanup is best effort and queued for retry. Backups include the database, managed audio, managed artwork, and a manifest, and restore protects the current library before replacing it.

## Verification

The frontend build, Sites tests, Rust tests, Tauri debug build, and packaged macOS app have been exercised on macOS arm64. The native app opens the persisted Test project, loads managed artwork, retains the player across navigation, and exposes the expected accessibility tree.

The remaining validation work is representative format playback, Windows/Linux behaviour, release signing, notarization, and a clean-account installation.
