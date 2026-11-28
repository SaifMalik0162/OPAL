# OPAL Alpha 5.4 — Pass A visual target

This folder contains the rendered visual target for the Notes / Tracks / Listen experience. The preview is isolated from the production app and uses local sample data.

## Preview

Run the OPAL prototype's Vite development server, then open:

- `http://127.0.0.1:4173/pass-a-preview.html` — carousel action group
- `http://127.0.0.1:4173/pass-a-preview.html?surface=notes` — Notes on the selected sleeve's reverse face
- `http://127.0.0.1:4173/pass-a-preview.html?surface=tracks` — Tracks on the same reverse face
- `http://127.0.0.1:4173/pass-a-preview.html?surface=listen` — immersive Listen surface

Useful visual states:

- Add `&theme=light` for the light theme.
- Add `&long=1` to test long project and track titles.
- Add `&context=track` to open Notes on a version with existing moments.
- Add `&compactActions=1` to exercise the alternate action row at narrow widths.
- Add `&missingArtwork=1` to inspect the branded missing-art fallback.

The browser review covered the 1240 × 820 baseline, 1920 × 1080 large display, 980 × 620 short window, 700 × 620 compact action row, light theme, long titles, and missing artwork. Captures were taken in the in-app browser at their CSS viewport sizes and visually reviewed. The browser screenshot API supplied review images but no filesystem output path, and the installed headless browser would not complete a local capture, so this folder does not contain exported PNG copies.

## Experience decisions

- The selected sleeve owns three visible sibling actions: Notes, Tracks, and Listen.
- Notes and Tracks share one reverse face. Notes keeps a restrained, blurred trace of the selected cover behind the editor, with the sleeve rim, position, and proportions intact.
- Listen is a full in-window surface. Artwork leads; a bounded title, context line, waveform, transport, queue, volume, and moment composer follow.
- Light and dark states keep text and controls theme-aware. The responsive layout reduces artwork before hiding essential playback controls.
- Focus returns to the exact action that opened Notes, Tracks, or Listen. Escape first closes an open Listen utility and then collapses Listen.

## Mismatch and polish ledger

| Finding | Resolution |
| --- | --- |
| The first Notes sketch used a separate sheet, which broke the existing sleeve relationship. | Replaced it with the same reverse-face flip used by Tracks, following the user's direction. |
| The first reverse-face render lost the card's rounded edge. | Inherited the sleeve radius through the turn surface. |
| The reverse artwork initially read as a flat panel. | Increased the cover's soft, low-contrast atmospheric presence while keeping editor contrast. |
| Queue placement competed with the waveform and title. | Moved the queue and volume surfaces to the Listen layer beside the artwork. |
| Browser defaults added a visible outline to queue rows. | Reset the row border and kept the interaction feedback as a quiet glass fill. |
| Light-theme Notes and Listen inherited dark-theme foreground values. | Added separate light-theme material and readable foreground tokens. |
| The long-title sample exercised only the carousel heading. | Extended the sample state to a two-line Listen track title. |

No known unresolved composition mismatch remains in the reviewed CSS viewport states. Native window chrome, Windows display scaling, custom application themes/background images, and coarse-pointer/reduced-motion runtime emulation belong to later integration passes; the preview includes source-level coarse-pointer and reduced-motion rules.

## Copy and scope

The only new action labels are **Notes**, **Tracks**, and **Listen**. Remaining visible copy belongs to the existing OPAL header/player composition or to the illustrative Night Bloom sample project, notes, versions, tracks, and moments. There are no release claims or permanent product-copy additions in this visual target.

The Notes editor is local preview state. Queue, transport, volume, waveform, and moment controls are illustrative interactions; they do not start audio, persist notes, or modify a real project. The waveform is explicitly labelled as illustrative sample data.

## Concepts

- [Notes reverse-face direction](concepts/opal-notes-reverse-face.png)
- [Listen direction](concepts/opal-listen.png)
