# OPAL — design notes

This is the visual contract for the current prototype.

## Character

OPAL is a violet listening room: immersive, tactile, and a little unexpected. The interface should make a collection feel gathered rather than catalogued. Artwork carries the colour; the UI gives it space.

The canvas is deep plum-violet, with dimensional sleeves, generous negative space, warm ivory type, and selective lavender glass. Nothing should feel like a bright dashboard or a wall of controls.

## Palette

| Token | Value | Use |
| --- | --- | --- |
| `--night` | `#17122F` | canvas |
| `--night-soft` | `#251B49` | deep surfaces |
| `--plum` | `#3E2A67` | controls and active surfaces |
| `--ivory` | `#F8F1EB` | primary type and highlights |
| `--lavender` | `#CDBBF1` | selection and progress |
| `--lavender-bright` | `#E3D7FB` | focus and selected type |
| `--glass` | `rgba(244, 237, 255, .14)` | translucent surfaces |
| `--line` | `rgba(244, 237, 255, .2)` | quiet structure |

## Type and shape

- Editorial serif (`Iowan Old Style`, `Baskerville`, `Georgia`) for OPAL, project names, and large statements.
- System sans (`Inter`, `SF Pro Display`, `ui-sans-serif`) for controls and metadata.
- An 8px rhythm, 32px desktop padding, and 20px compact padding.
- 22–28px surfaces for the hero and player; 14–18px for controls.
- Soft elevation and hairline borders. No decorative noise.

## Material

Glass belongs on the player, navigation, sleeve rail, notes, import prompt, and project surfaces—not everywhere. Backdrop blur is optional; unsupported and reduced-transparency environments use opaque deep-plum panels with the same contrast and geometry.

## Shell

The product has four enduring pieces:

1. A restrained top bar with OPAL, Library, Projects, local status, search, and settings.
2. A Library built around a centred sleeve carousel and recent-project rail.
3. A focused project view with artwork, context, tracks, and notes.
4. A compact floating player that survives navigation.

`Import music` is the primary action. Cloud sharing and project collaboration are future work, not implied by the current UI.

## Behaviour

- Selection updates the sleeve, project context, and player together.
- Navigation does not interrupt playback.
- Track rows, queue actions, notes, search, import, and volume stay keyboard-addressable.
- Notes save locally and expose a quiet saving state.
- Reduced motion removes ornamental movement; reduced transparency removes blur without changing hierarchy.

## Current boundary

The prototype is local-only. It has a Tauri shell, SQLite-backed projects and tracks, managed audio and artwork, and webview playback. Accounts, sync, sharing, and release-grade cross-platform validation come later.
