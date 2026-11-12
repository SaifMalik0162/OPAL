# Projects carousel visual QA

final result: passed

Compared the original option 2 render and the Projects route from OPAL main at `9530920` together at the same aspect ratio. The source render is 1487 × 1058 pixels. The browser viewport was 1440 × 1024 CSS pixels. The preview used generated mineral covers and synthetic audio.

The first pass had a brighter blue backdrop, reversed perspective on the neighboring covers, and clipped outer covers. The revised view restores the dark plum field, turns the neighbors inward, and spaces all five covers within the desktop stage. The large serif title, warm play action, cover edges, and centered selection match the reference hierarchy. The development badge, app navigation, sort control, and player use current main. The Tracks disclosure is an intentional addition.

Verified drag and arrow navigation, opening the selected project, track preview playback, Grid persistence across reload, search recovery, and a 620 CSS pixel viewport without horizontal page overflow. No browser console errors were observed. Native WebView animation and playback still need a device pass.

## Follow-up: blue background and project detail

The Projects index now uses the shared OPAL background. The header measured identical in Grid and Carousel at 1440 × 900. Grid was selected after clearing the sample preview's saved layout. At 620 × 620 the carousel buttons ended 31 px above the player. The open Tracks preview scrolled into view and ended 12 px above the player. A mouse drag in either direction and a horizontal browser scroll advanced the selection.

The updated project detail follows the supplied Untitled references with artwork beside a readable track list, quiet row actions, and a split track details dialog. OPAL's existing mixes, project and version notes, Moments, and Capsules are organized into separate sections. Verified alternate mix expansion, opening track details, opening version notes from the track menu, saving a sample note across section switches, and returning to Projects. The browser used a mock library and note backend, so native trackpad gestures and SQLite writes were outside this visual pass.
