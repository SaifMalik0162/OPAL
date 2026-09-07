# OPAL Pass 1 Design QA

Date: 2026-09-05

## Comparison target

- Source visual truth: `/Users/saifm/Downloads/IMG_4026.JPG` plus the supplied player and carousel references `/Users/saifm/Desktop/Screenshot 2026-09-05 at 8.19.59 PM.png`, `/Users/saifm/Desktop/Screenshot 2026-09-05 at 8.34.32 PM.png`, and `/Users/saifm/Desktop/Screenshot 2026-09-05 at 8.20.09 PM.png`.
- Implementation: `http://localhost:4173/`, browser-rendered inline CUA captures from the local prototype (desktop library, responsive library, and open-project states). Codex Desktop exposed the captures inline but did not expose a filesystem screenshot path.
- Implementation capture: desktop CUA output rendered at approximately 1512 x 728, plus a narrow responsive in-app preview; device scale factor was not exposed by CUA, so no density normalization was applied.
- State: library view checked with Dusk Atlas, Slow Light, and Night Bloom selected; player playing, no modal. The open-project state was checked with the selected track and player context retained.
- Comparison intent: the source is a portrait listening composition while OPAL is a desktop product. The comparison therefore checks composition, atmosphere, sleeve hierarchy, and floating-player behavior rather than device-frame or pixel-size parity.

## Findings

No actionable P0, P1, or P2 findings remain.

### Fonts and typography

The implementation uses an editorial serif stack for the large collection and project titles, with a system sans for controls and metadata. This creates the requested elegant OPAL tone while keeping the small UI readable. The source reference uses a more uniformly sans treatment; this is an intentional brand distinction, not a break in hierarchy. Text remains readable at the captured viewport and is not clipped.

### Spacing and layout rhythm

The library matches the source compositionally: a centered primary sleeve, angled supporting sleeves, large negative space, and a compact centered player pill anchored to the bottom. All sleeves share one card geometry; the supporting cards use only restrained scale and rotation to create depth, while every card’s title and metadata are centered. The current desktop render keeps the selected project caption above the player and removes the compact-height recent rail when it would compete with the listening moment. The open-project render exposes artwork, project context, tracklist heading, and notes while retaining the same player position.

### Colors and visual tokens

The implementation now uses a deep plum-violet canvas with a real artwork-derived ambient field, warm ivory text, lavender selection states, and low-opacity white/lavender glass. This is materially closer to the supplied reference than the earlier bright ivory surface and keeps OPAL’s original palette as accents. Unsupported or reduced-transparency environments fall back to a solid deep glass surface without changing hierarchy.

### Image quality and asset fidelity

All visible artwork is served from local generated raster assets in `public/artwork/`: `veil-atlas.png`, `slow-light.png`, and `night-bloom.png`. The reference’s visual role of album imagery is represented with individual square artwork, no placeholder boxes, no CSS-drawn images, and no borrowed app branding. The artwork is cropped consistently into the center sleeve, side sleeves, player thumbnail, and project view.

### Copy and content

OPAL copy is now intentionally quiet and operational. Poetic helper lines, promotional microcopy, and redundant status labels were removed; remaining text names the current action, project, track, or import result directly.

### Icons and controls

Player, search, navigation, carousel, import, notes, and queue controls use the Phosphor icon library. Buttons have semantic labels and focus styling. No inline SVG or text-glyph substitute was used for the control icons.

The player follows the supplied references without becoming a full-width utility bar: transport controls sit on the left, the active track gets a darker inset module with artwork and options, waveform/progress occupies the center, and volume/queue actions sit on the right. This gives the player a distinct visual identity while preserving the persistent listening behavior.

### States and interactions checked

- Sleeve selection changes the selected project and updates the player context.
- Previous/next and play/pause controls update the player state.
- Queue opens and exposes the next tracks.
- Projects navigation opens the project view without interrupting the player.
- Track selection updates the active row and player track.
- Notes can open and close; note persistence remains deferred.
- Search filters the visible project rail.
- Import opens a clear modal state and can be closed.
- Volume stays as a single player icon until activated, then expands into an accessible vertical slider and collapses back without changing the player width.
- Keyboard-focus outlines and reduced-motion/reduced-transparency CSS fallbacks are present.

## Comparison history

1. Earlier bright ivory implementation: the canvas and surfaces diverged from the supplied reference and weakened the intended modern listening mood. Fixed by moving to a dark full-bleed plum-violet shell, centered sleeve carousel, and floating player.
2. First dark implementation: the header/search row collided, and the compact-height player obscured the library caption/rail. Fixed by placing search beside the OPAL mark, tightening the stage, and suppressing only the non-essential rail at short desktop heights.
3. Final compact render: Import was promoted into the top bar so the primary action remains visible even when the recent rail is hidden. The sleeve cards were normalized and the player was tightened into a centered dock based on the supplied desktop references. No actionable P0/P1/P2 differences remain.

## Follow-up polish

- If exact visual parity with the supplied reference becomes the priority, consider a dedicated reference-style sans display face for the large headline in Pass 2. The current serif treatment is the deliberate OPAL brand interpretation.
- Validate the same composition at a true 1440 x 1024 desktop window and on each target OS once the Tauri shell exists.

## Implementation checklist

- [x] Dark reference-aligned library composition
- [x] Centered sleeve carousel with selected state
- [x] Persistent floating player across library and project views
- [x] Open-project artwork, tracklist, and notes states
- [x] Visible import state and local-first messaging
- [x] Real raster artwork and icon library
- [x] Responsive and reduced-transparency fallbacks
- [x] Build and Sites packaging tests passing

final result: passed

## Pass 3 local library verification

Date: 2026-09-06

- The sample-only library was replaced with a real empty state backed by Tauri commands. Project creation, title/description edits, native audio selection, native artwork selection, and project reload all use stable local records.
- SQLite migration and SHA-256 duplicate handling are covered by Rust tests. Import code stages copies, commits managed relative references, preserves source bytes, reports per-file results, and cleans the exact staging directory on startup or completion.
- The UI keeps the established reference composition: uniform centered sleeves, centered card metadata, dark plum/lavender glass, and a prominent centered floating player. Notes remain deferred; Pass 4 now owns local webview playback.
- The native window was rebuilt and launched successfully. Liquid Glass initialised, and the topbar now has both `data-tauri-drag-region="deep"` and an explicit native drag fallback that excludes interactive controls.
- Known limitation: full end-to-end import/restart evidence requires exercising the native file picker with real WAV/MP3/FLAC/AIFF/M4A fixtures. Browser preview is intentionally read-only and shows the new empty-library state because Tauri commands are unavailable outside the desktop shell.
- Command wiring was corrected after native smoke testing exposed a naming mismatch: the Rust registry now explicitly exports the same camelCase names used by the React invoke calls, and the rebuilt binary contains all six command names.

## Pass 2 desktop foundation verification

Date: 2026-09-06

- Tauri 2 shell builds successfully with a 1240 x 820 default window, 980 x 620 minimum, native decorations, an overlay macOS titlebar with evenly inset integrated traffic lights, and Tauri's deep drag region that excludes clickable controls and inputs.
- macOS 27 arm64 launch was verified from the final source state; runtime logging confirmed native Liquid Glass was applied. AppKit vibrancy remains the fallback when Liquid Glass is unavailable.
- The library and open-project captures show one cohesive dark plum/lavender visual system, centered sleeve cards, centered player dock, readable tracklist/notes surfaces, and long-title handling.
- Library to project and back preserves the selected track in the persistent player. Notes can hide/show without losing project context. Search exposes an empty-library recovery state. The volume control remains icon-only until expanded into the vertical slider.
- `npm run build`, `npm run test:sites`, `git diff --check`, and `npx tauri build --debug --no-bundle --ci` passed.
- Windows and Linux shell/material behavior remain unverified until tested on those operating systems.

## Pass 4 listening verification

Date: 2026-09-06

- The UI now uses one persistent audio controller across library and project navigation. Track rows, project play, play/pause, previous, next, seek, volume, mute, and queue selection are connected to the same controller.
- The player keeps a centered, compact dock; only the volume icon expands into a vertical control. Stale async playback requests are ignored, failed files remain visible in the library, and the player reopens paused.
- The browser preview confirms the cleaned empty-library copy, but cannot play managed local files. The native app build is current; the persisted native library is available for the WAV playback click-through.

## Pass 5 local workflow verification

Date: 2026-09-06

- The visible interface is now quieter: no promotional tagline, local-sync label, redundant helper copy, or placeholder note text remains in the primary library and project flow. Empty-project duration uses a single dash rather than explanatory filler.
- Project details, track display titles, artwork, ordering, project notes, and track notes are wired to the local SQLite model. Note context is explicit and save state stays subtle: Saving, Saved, or Couldn’t save.
- Track rows remain readable and keyboard-addressable while exposing only the small actions needed for reorder, rename, notes, and removal. Search can target a track, open its containing project, and highlight the matching row. Sorting is persisted locally.
- Deletion confirms the project or track name, distinguishes OPAL-managed copies from original source files, and updates playback state deliberately. Non-active track removal keeps the current audio running while active-track removal stops it.
- The compact dock keeps the reference composition: transport on the left, active track in the center, progress in the middle, and icon-only volume/queue controls on the right. The expanded volume slider is lavender throughout; the prior yellow accent is removed from the source styles.
- Native macOS inspection confirms the rebuilt app opens the migrated v3 database with the persisted Test project, three managed tracks, integrated traffic lights, centered dock, and resolved artwork. WAV playback is available for final click-through; other formats remain unverified in the webview.
- Windows and Linux behavior remain unverified until those operating systems are tested.

Pass 5 result: passed

## Pass 6 stabilization QA

Date: 2026-09-06

- The avatar is now a local Settings popover rather than a placeholder profile. Its actions are limited to local storage, backup/restore, diagnostics, appearance, accessibility, and version information.
- The three-dot player menu has five concrete local actions. The menu is anchored to the player, closes after an action, dismisses on outside pointer input, and supports Escape.
- Import progress is retained after closing the modal. The modal cannot be dismissed by an accidental backdrop click while work is active, and duplicate choices remain explicit.
- Confirmation dialogs use the shared OPAL modal frame. Escape, focus trapping, focus restoration, semantic labels, keyboard track actions, and visible disabled states were checked in the browser preview.
- The new full backup path is validated by manifest/database checks before restore. Current storage is copied to a recoverable pre-restore folder before replacement. Cleanup failures become queued startup work rather than false deletion failures.
- Automated verification is green: 8 Rust tests, 3 note-revision tests, 3 playback queue tests, 4 Sites tests, production frontend build, and Tauri debug build.
- Native packaged-app smoke check passes: the Release `.app` now loads `tauri://localhost` and renders the persisted Library state instead of the blank transparent surface caused by the overly narrow navigation allow-list.
- Release packaging remains partial on this host: the Release `.app` was built, but DMG creation cannot be verified because this runner reports `hdiutil: create failed - Device not configured`, and signing cannot begin because the keychain has no valid identities. Do not describe the artifact as signed, notarized, stapled, or clean-account verified.

Pass 6 result: implementation complete with release-gate blockers documented

## Phase 1 data protection QA

Date: 2026-09-06

- Track-note ownership regression passes: project and track note keys map to mutually exclusive `saveNote` payload fields.
- Stale-save regression passes: an older blocked write cannot clear or replace a newer draft; the newer draft is sent after the older write completes.
- Failed-save regression passes: the draft stays in the local journal after an error and is removed only after a later retry succeeds.
- Quit and context behavior uses the same flush queue. The draft journal is written on edit, flush is attempted before navigation and window close, and a failed flush leaves the text available for the next session.
- Project deletion regression passes for `NULL` artwork references. Record deletion is committed before managed-file cleanup, and cleanup failures are queued for startup retry.
- Startup recovery regression passes: abandoned `.staging` content is removed only after database initialization and integrity checks; completed managed audio remains present.
- Import concurrency regression passes: a second import for the same project is rejected by the Rust guard while the first import owns track-position assignment.

Verification: `npm run test:notes`, `cargo test --manifest-path src-tauri/Cargo.toml`, `npm run build`, and `git diff --check` all passed.

final result: passed

## Projects visual refinement QA

Date: 2026-09-06

### Visual truth and implementation evidence

- Source visual truth: `/Users/saifm/Desktop/Screenshot 2026-09-06 at 2.26.13 AM.png` is the supplied Projects-grid reference, 2180 x 1432 px. `/Users/saifm/Desktop/Screenshot 2026-09-06 at 2.26.21 AM.png` is the supplied open-project reference, 2180 x 1432 px.
- Implementation captures: `/private/tmp/opal-projects-grid-native.png` and `/private/tmp/opal-project-detail-native.png`, each 3024 x 1964 px full-display macOS captures. The OPAL window inside each capture is the configured 1240 x 820 logical-pixel desktop surface at approximately 2x Retina density; the surrounding desktop is retained to prove the native app was foregrounded.
- State: the packaged Release `.app` was launched with the persisted Test project. The grid capture shows the Projects route with one project sleeve, a uniform New project tile, sort control, and persistent player. The detail capture shows the same project with large artwork, title/actions, Add tracks, track rows, Notes, and persistent player.

### Comparison

- Full view: the supplied grid uses a dark, sparse four-column collection with square artwork and a single play control. OPAL adopts that structure while preserving the deep-plum/lavender brand material and local-library actions.
- Focused detail: the supplied project view uses one large cover, a concise identity block, Add tracks, and a vertically quiet track list. OPAL matches that hierarchy and keeps Notes plus the persistent player as the product-specific listening workflow.
- Interaction evidence: native accessibility state exposed Projects, Sort projects, New project, Play Test, and Test; opening Test exposed Add tracks, track controls, Notes, and the persistent player. The browser fallback separately exposed the Projects empty state, sort choices, and Create project action.

### Findings and history

- No P0, P1, or P2 visual findings remain for this refinement.
- The earlier Projects screen was a visually heavy extension of the Library carousel. It was replaced with a true collection grid so card geometry, action placement, and metadata line up consistently.
- The earlier project view repeated hierarchy across multiple stacked surfaces. It was replaced with the split cover/workspace composition and quiet-on-default track actions.
- Intentional deviation: OPAL does not add an overflow menu to every project card. The requested local actions already have direct, semantic controls in the project view, so omitting repeated dots keeps the collection scan cleaner while preserving functionality.

final result: passed
