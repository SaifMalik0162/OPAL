# OPAL Desktop Foundation

## What is connected

OPAL now runs as one Tauri 2 desktop application around the React/Vite interface. The Pass 2 shell and dark reference-led visual system now sit above a real local library with persistent projects, managed audio, managed artwork, and a single application-level webview player.

The native shell owns the window. Accounts, cloud sync, and sharing remain deferred to later passes.

## Window contract

- Default size: 1240 x 820 logical pixels.
- Minimum size: 980 x 620 logical pixels.
- Resizable, centered, and not fullscreen by default.
- Native decorations remain enabled so macOS traffic lights and Windows/Linux window controls are preserved.
- macOS uses an overlay titlebar with traffic lights positioned 28 logical pixels from the top and side; the title stays hidden, and the header uses Tauri's deep drag-region mode so nested empty header space moves the window while controls and inputs remain clickable. Full-screen reveal/hide behavior remains native to macOS.
- The frontend keeps transparent document roots and a deep plum translucent canvas so native material can show through without making the app bright.

## Material strategy

- macOS 26+: attempt native Liquid Glass through `window-vibrancy`; if unavailable, fall back to AppKit HUD vibrancy.
- Windows: attempt Mica, then Acrylic, then blur.
- Linux: do not assume compositor blur; retain the deep-plum CSS fallback.
- Reduced transparency: CSS removes backdrop blur and uses an opaque deep-plum surface while preserving the same hierarchy and contrast.

## Verification status

- Frontend production build: verified.
- Sites packaging tests: verified.
- Tauri configuration validation: verified through the Tauri CLI.
- macOS native launch: verified on macOS 27 arm64; the dev shell logged `OPAL native Liquid Glass applied`.
- Windows/Linux launch and material behavior: unverified until those platforms are available.

## Pass 2 verification note

- The final source state was rebuilt with `npm run build`, `npm run test:sites`, and `npx tauri build --debug --no-bundle --ci`.
- The connected library and project states were inspected in the live Vite/Tauri frontend preview at the configured 1240 x 820 desktop composition.
- Notes open/close, selected-track changes, player continuity across navigation, empty search recovery, and compact volume expansion were exercised.
- Reduced motion and reduced transparency are implemented as CSS fallbacks; runtime OS preference toggling was not changed during verification.

## Pass 3 local persistence

- OPAL now initialises a versioned SQLite database at the platform app-data location as `opal.sqlite`. The first migration creates stable-ID `projects` and `tracks` tables, with ordered tracks, duration, format, relative managed-file references, and SHA-256 source hashes.
- Managed audio lives under `audio/<project-id>/`; artwork thumbnails live under `artwork/<project-id>/`. Imports stage copies under `.staging/` before committing them, and startup removes only that exact staging folder to clean interrupted work. Source files are never edited or removed.
- The library is empty on a new install. Create-project and edit-details dialogs write through to SQLite. Project sleeves, track rows, ordering, metadata summaries, and artwork survive reloads.
- Native dialogs support WAV, MP3, FLAC, AIFF/AIF, M4A audio and PNG, JPG/JPEG, WEBP artwork. Metadata is best-effort through Lofty; unreadable metadata falls back to the filename and stores the original bytes unchanged. Playback compatibility is tracked separately in the Pass 4 record below.
- Audio imports report per-file progress, unsupported/missing/read failures, and duplicate hashes. Duplicate files are held for an explicit import-again or skip decision. A managed thumbnail is generated separately from the selected artwork source.

### Native command contract

The frontend and Rust shell use explicit camelCase command names: `listProjects`, `createProject`, `updateProject`, `setProjectArtwork`, `removeProjectArtwork`, `importAudioFiles`, `updateTrackTitle`, `reorderTracks`, `saveNote`, `deleteTrack`, and `deleteProject`. Their payload keys also use camelCase, including `projectId`, `trackId`, `sourcePath`, `allowDuplicates`, and `trackIds`.

## Pass 3 verification

- `npm run build`, `npm run test:sites`, `cargo test --manifest-path src-tauri/Cargo.toml`, `git diff --check`, and `npx tauri build --debug --no-bundle --ci` pass on macOS arm64.
- Rust tests cover idempotent migration, ordered track schema inserts, stable content hashing, and filenames containing spaces, Unicode, and an em dash.
- The rebuilt native dev shell launches with `OPAL native Liquid Glass applied`. The header keeps Tauri deep drag-region semantics and calls native `startDragging()` for non-control header space as a direct fallback.
- Windows and Linux behavior remain unverified until those platforms are available.

## Pass 4 local playback

- Playback is owned by `App` rather than a screen. One `HTMLAudioElement` holds the current source, queue, position, duration, volume, mute state, and transient load/error state while navigation changes only the selected view.
- Managed audio resolves through Tauri's scoped asset protocol using each track's `managedFilePath`. Source files are never opened directly from the user's original location, and missing or undecodable files keep their project records while showing an actionable player error.
- Selecting a track replaces the queue with the saved project order. Completion advances once, stops at the end, and ignores stale event handlers when a track changes quickly. Previous restarts the current track after four seconds; otherwise it moves back one track.
- Volume is persisted locally and remains icon-only until opened. The open control expands into the vertical lavender slider shown in the supplied reference. The last track identity is remembered, but relaunch remains paused with no autoplay.

### Playback verification record

- Production frontend build, Rust tests, and Tauri debug build pass on macOS arm64.
- The final Tauri dev process launches and logs `OPAL native Liquid Glass applied`. The unlocked native window was inspected with the persisted Test project and managed track artwork visible.
- The stored Test project contains managed WAV files and is ready for the native click-through. MP3, FLAC, AIFF, and M4A are accepted by the import dialog and storage layer, but their actual webview playback is not yet marked verified.
- Windows and Linux playback/material behavior remain unverified until those platforms are tested.

## Pass 5 local workflow

- SQLite schema version 3 adds one plain-text note per project or track plus a managed-cleanup queue. Notes save locally after a short pause, flush when context changes, and retain the draft when a save fails.
- Project details and artwork remain editable. Track display titles can be renamed without touching managed audio, and tracks can be reordered by drag-and-drop or the keyboard up/down controls.
- Library search checks project and track titles. A track hit opens its project and highlights the matching row. Project sorting supports recently updated, newest, and alphabetical order.
- Track and project deletion is explicit and names the affected OPAL-managed copies. Original source files are never deleted; managed files are removed only when no remaining record references them.
- The player remains application-level and keeps the active queue through navigation and non-active track edits. Removing the active track stops playback; removing another track updates the queue in place.
- The compact player volume control stays icon-only until opened. Its vertical slider uses the OPAL lavender accent throughout, including the filled track and thumb.

### Pass 5 verification record

- `npm run build`, `npm run test:playback`, `npm run test:sites`, `cargo test --manifest-path src-tauri/Cargo.toml`, and `npx tauri build --debug --no-bundle --ci` are the required local verification commands.
- Native macOS inspection confirms the v2 database opens, the persisted Test project and three tracks render, the centered player remains visible, and the managed track/artwork references resolve.
- Windows and Linux remain unverified. Format playback beyond the stored WAV fixtures remains a Pass 4 compatibility limitation until representative files are tested in each target webview.

## Pass 6 stabilization

- Release identity is locked to `com.opal.library` and the product version is `0.1.0-alpha.1`, described as a local-only macOS alpha. The webview CSP is restrictive, the asset protocol is scoped to OPAL-managed `audio/` and `artwork/`, and native navigation accepts only the packaged origin plus the development localhost origin.
- The profile avatar opens local Settings: storage totals, the OPAL folder path, reveal-folder, complete backup export, verified restore staging, appearance preferences, diagnostics, and version information. It contains no account, cloud, or sync language.
- The player menu now opens the current project, locates the current track, opens track notes, reveals the managed audio file, and shows format/duration/managed-file information. Menu actions close cleanly and are keyboard addressable.
- Notes use separate draft and persisted refs. Each save carries a context key, revision, and draft value; stale responses cannot overwrite a newer draft. Pending text is flushed on context changes and window close.
- Imports are serialized per project in both React and Rust. The latest progress remains available after the modal closes, duplicate hashes are held for an explicit choice, and interrupted staging is removed at the next startup without touching completed managed audio.
- Startup runs SQLite integrity checks, backs up existing databases before migrations, exposes a recovery screen on unsafe open, and retries queued managed-file cleanup after deletion. Backup export includes the database, managed audio, managed artwork, and a manifest; restore first protects the current library in a pre-restore backup.
- Native confirmation prompts are replaced with OPAL dialogs with Escape handling, focus restoration, focus trapping, and backdrop dismissal disabled for import work. Disabled project navigation explains that a project must exist first.

### Pass 6 verification record

- `npm run build` passes and leaves the client, Sites server, and hosting manifest artifacts.
- `npm run test:playback`, `npm run test:sites`, and `npm run test:notes` pass. Rust `cargo test --manifest-path src-tauri/Cargo.toml` passes 8 tests covering schema v3/idempotence, migration backups, note persistence, stable hashes, cleanup/reference behavior, pending cleanup, per-project import serialization, and backup-manifest validation.
- `npx tauri build --debug --no-bundle --ci` passes. A Release app bundle was created with `npx tauri build --bundles app --ci`.
- Packaged macOS verification now passes after allowing the actual production `tauri://localhost` origin: the rebuilt `.app` opens to the Library screen, exposes its HTML accessibility tree, renders the persisted Test project and artwork, and keeps the integrated traffic lights and centered player visible.
- Tauri's generated DMG helper could not run in this checkout because its optional Finder support directory is absent. `scripts/release-macos.sh` uses an app-only `hdiutil` DMG path so release packaging is deterministic in CI and non-Finder environments. This runner's `hdiutil` returned `Device not configured`, so the DMG fallback is not claimed verified here.
- This Mac has `0 valid identities found` for code signing. Developer ID signing, notarization, stapling, and clean-account installation remain blocked until a Developer ID certificate and notarization credentials are supplied on a normal macOS packaging environment. The script preflights these instead of silently producing a false release.
- No representative MP3, FLAC, AIFF, or M4A fixtures were available for an honest packaged-webview format matrix. Only the existing managed WAV path remains a manual native check; all other formats stay unverified and are not advertised as playback-supported.
- Windows and Linux packaging, playback, and material behavior remain future validation targets.

## Phase 1 data protection

- Track-note saves now send exactly one owner to SQLite. Project notes use `projectId`; track notes use `trackId`, so track saves satisfy the database ownership check.
- A local pending-note journal stores drafts synchronously, serializes writes, and removes a journal entry only after the matching draft succeeds. A newer draft remains queued while an older request is in flight, and failed drafts remain available for retry after navigation or relaunch.
- Deletion commits the project or track record first. Managed-file removal is best effort and uses `cleanup_queue` for startup retry, so a cleanup problem cannot report a completed record deletion as failed. Projects with `NULL` artwork references delete through the same path as projects with artwork.
- Startup validates and migrates the database before recovering abandoned `.staging` batches. Only staging content is removed; completed managed audio and artwork under `audio/` and `artwork/` remain intact. Import guards still allow one active import per project and preserve deterministic track positions.

### Phase 1 verification

- `npm run test:notes`: 6 passing tests.
- `cargo test --manifest-path src-tauri/Cargo.toml`: 10 passing tests.
- `npm run build`: passing production frontend and Sites artifacts.

## Projects visual refinement

- The Projects route now follows a calm collection-grid composition: equal square sleeves, one consistent play affordance, centered create tile, short metadata, and no decorative overflow controls. The Library route keeps its art-led carousel identity; Projects is the uniform management view.
- The project detail route now uses a focused split layout: one large artwork sleeve on the left, project title/actions and Add tracks on the right, then a restrained track workspace with Notes beside it. The persistent player remains centered and visible across both routes.
- Track actions remain real and keyboard-accessible, but recede until a row is hovered, focused, or currently playing so the default list reads like the supplied reference instead of a toolbar.
- Visual verification was performed in the packaged macOS `.app` at the configured 1240 x 820 logical window size. The app used the native dark plum material with integrated traffic lights and retained the persisted Test project, three managed tracks, artwork, Notes, and centered player.
