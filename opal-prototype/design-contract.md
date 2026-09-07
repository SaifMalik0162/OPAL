# OPAL — Pass 1 Design Contract

OPAL is a local-first music library that makes a personal collection feel collected, not catalogued. The first design pass establishes the emotional center of the product before desktop infrastructure is introduced.

## North star

OPAL should feel like a violet listening room with translucent record sleeves floating in front of you: immersive, tactile, and a little surprising. The interface is an instrument for returning to a collection, not a dashboard for managing files.

The supplied reference direction contributes:

- a saturated violet atmosphere with a strong center of gravity;
- dimensional, overlapping sleeves that make artwork feel alive;
- a floating listening surface that stays present while the user moves around;
- generous negative space and a premium, almost cinematic pace;
- a dark full-bleed canvas rather than a bright white workspace.

OPAL keeps that sense of spectacle while grounding it in warm ivory, deep plum, lavender light, and readable desktop controls. Warm ivory is now an accent for type and sleeve highlights; the canvas is deep plum-violet.

## Visual tokens

| Token | Value | Role |
| --- | --- | --- |
| `--night` | `#17122F` | application canvas |
| `--night-soft` | `#251B49` | deep surface |
| `--plum` | `#3E2A67` | warm plum controls |
| `--ivory` | `#F8F1EB` | primary type and highlights |
| `--lavender` | `#CDBBF1` | active selection and progress |
| `--lavender-bright` | `#E3D7FB` | selected type and focus |
| `--glass` | `rgba(244, 237, 255, .14)` | translucent surface |
| `--line` | `rgba(244, 237, 255, .2)` | hairline structure |

Artwork supplies the richer color moments. The UI should not compete with it using extra badges or a second accent palette. Ambient color comes from real artwork assets blurred behind the app shell.

## Typography

- Display: an editorial serif stack (`Iowan Old Style`, `Baskerville`, `Georgia`) for OPAL, page titles, project names, and the occasional statement.
- Interface: a clean system sans stack (`Inter`, `SF Pro Display`, `ui-sans-serif`) for navigation, metadata, buttons, and track rows.
- Body baseline: 14–16px; default line-height 1.45.
- Display titles use restrained tracking and generous line-height rather than oversized UI type.

## Spacing and shape

- Base rhythm: 8px.
- Main padding: 32px desktop, 20px compact.
- Section gaps: 24–40px.
- Surfaces: 22–28px radius for hero and player, 14–18px for controls.
- Borders are hairline and low contrast. Elevation is soft and used only to separate the floating player and hero sleeves from the canvas.

## Glass treatment

Glass is selective, not a texture applied to every element. The floating player, top navigation, sleeve rail, notes panel, import prompt, and project surfaces may use blur-backed translucent lavender-white. The app canvas remains deep plum-violet so the interface feels closer to the reference rather than bright and white.

On supported Macs, `backdrop-filter` enables the refractive surface. With reduced transparency, unsupported webviews, Windows, or Linux fallback behavior, the same surfaces become opaque deep-plum panels with the same borders, radii, spacing, and contrast.

## Navigation and hierarchy

The app has one persistent shell:

1. **Top bar** — OPAL mark, minimal Library/Projects navigation, local status, and profile affordance.
2. **Library** — collection as a centered sleeve carousel with one shared sleeve geometry, shallow depth scaling on the side cards, a clear selected project, and a compact recent-project rail.
3. **Open project** — a large sleeve, project context, tracklist, and notes panel using the same dark glass shell.
4. **Floating player** — a centered, compact listening dock persistent across both views, independent from navigation and notes. It combines transport controls, a dark track module, waveform/progress, and queue/volume actions.

The primary action is `Import music`. Search is intentionally global and calm. Project creation and cloud sharing are not represented yet; they belong after local import and listening are validated.

## Essential interaction states

| State | Expected behavior |
| --- | --- |
| Library selected | top navigation, hero copy, and sleeve selection share the same lavender signal |
| Project selected | selected sleeve gains a quiet plum outline and the project can be opened without losing player state |
| Playing | player reports the active track and its progress; navigating does not interrupt it |
| Track selected | row becomes a plum-tinted surface and current track artwork updates in the player |
| Notes editing | note copy is editable in place; status moves through `Saving…` to `Saved locally` |
| Import prompt open | the app shows the intended drop/picker state without implying a backend exists |
| Search active | recent projects filter in place; no separate search screen is introduced |
| Reduced transparency | all glass surfaces become solid ivory while hierarchy remains unchanged |

## Pass 1 prototype boundary

The included prototype is a visual and interaction artifact only. It uses sample projects and generated artwork, does not persist data, does not play real audio, and does not create the Tauri shell. Pass 2 begins the desktop foundation after this direction is accepted.
