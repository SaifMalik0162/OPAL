# Track details QA

Source visual truth:
- /Users/saifm/Desktop/Screenshot 2026-11-17 at 10.57.23 PM.png
- /Users/saifm/Desktop/Screenshot 2026-11-17 at 10.58.03 PM.png
- /Users/saifm/Desktop/Screenshot 2026-11-17 at 11.05.25 PM.png
- /Users/saifm/Desktop/Screenshot 2026-11-17 at 11.05.30 PM.png

Implementation:
- /tmp/opal-details-controls-fixed.png
- /tmp/opal-details-transfer-progress.png

Viewport: 319 × 800 CSS pixels and screenshot pixels at density 1.
State: active version and pending version, manually entered BPM 160. Native metadata unavailable in the isolated browser preview.
Intentional adaptation: reference layout and interactions with existing OPAL theme tokens. Source is 796 × 1440 pixels at approximately 2x density; narrow implementation is 319 CSS pixels. Title, key/tempo, waveform, stacked cards, and bottom actions are retained.

Findings and fixes:
- Removed the label's opaque background by using a native fieldset legend, creating a real gap in the card border.
- Key and BPM controls use matching sizes, inline alignment, and text entry with decimal keyboard and numeric validation. Native number spinners removed.
- Removed artwork and the technical-facts grid to follow the reference layout. Audio metadata is a compact line.
- Waveform reuses OPAL's actual audio analysis and playback controls.
- Versions show filenames, source date when known, an active border/legend, and overflow actions.
- Native copying now runs on a background thread with real byte counts and a throttled event stream.
- The pending card stays busy until the database save and promotion finish, then updates from refreshed project data.
- Duplicate/failed imports enter the existing review prompt without a details dialog covering it.

Evidence:
- Full source and first layout capture displayed in one comparison response.
- Both reported issue screenshots and the corrected pending-state capture displayed in one comparison response.
- Actual component preview: entered BPM 160 successfully, confirmed it is a text field, triggered Add new version and saw 26.9 MB / 46.8 MB with disabled add action.
- Pending-state progress is supplied sample props for visual inspection; native byte correctness is covered by Rust tests.
- Native tests passed for exact byte counts, copy integrity, failure rollback, and active-version invariants.
- Frontend build passed.

Required surfaces reviewed: typography uses OPAL UI and monospace file metadata; spacing follows the reference hierarchy; colors use theme tokens; actual Phosphor icons and audio-derived waveforms are reused; labels and copy match the requested controls.
Native end-to-end import/playback remains a device acceptance gap.
final result: passed

## Key and BPM dropdown refinement

Source references:
- /Users/saifm/Desktop/Screenshot 2026-11-17 at 11.08.11 PM.png
- /Users/saifm/Desktop/Screenshot 2026-11-17 at 11.08.18 PM.png

Rendered screenshots:
- /tmp/opal-key-picker.png
- /tmp/opal-bpm-picker.png

Viewport and normalization: 319 × 800 CSS pixels at density 1. Each reference is a cropped popover (682 × 530 and 414 × 116 pixels), compared as a component within the complete dialog.
State: Gb Major picker, then Gb Minor with BPM 176.
Both source and rendered capture were displayed together for each popover.
Typography, centered header and controls, compact layout, theme colors, sharp/flat spelling, selected state, and existing Phosphor icons inspected.
Browser checks: picked Gb then Minor; typed 176, incremented to 177 and decremented to 176; Escape closed only the popover and restored trigger focus. Alternate actions exposed Delete version, and the preview's sample delete callback removed that card.
Native deletion continues through the existing confirmation and backend flow. The details dialog is suspended during confirmation to avoid two active focus traps. Successful deletion refreshes its project and selected track.
The native deletion regression passed. Browser preview does not exercise actual file deletion or the native confirmation.
final result: passed

## Version count shortcut

Source: /Users/saifm/Desktop/Screenshot 2026-11-17 at 10.53.04 PM.png, supplied with the request to remove the ribbon.
Implementation screenshot: /tmp/opal-version-count-shortcut.png
Viewport: 319 × 800 CSS pixels at density 1.
The expanded alternate-take ribbon, expansion state, and unused ribbon styles/callbacks were removed. The existing count remains, with a dialog label and tooltip, and opens the current version's Track details. Its arrow is removed.
Actual ProjectView preview showed one song and a count of two, with no expanded cards. Clicking the count rendered the actual TrackInfoDialog with its active and alternate versions.
Typography and theme remain OPAL's existing track row styling. No extra visual assets or content were introduced. The preview is narrow; wider desktop native layout was not captured in this check.
Build passed.
final result: passed

## Fixed dialog height and scrolling versions

Source: /Users/saifm/Desktop/Screenshot 2026-11-17 at 11.24.39 PM.png
Rendered evidence:
- /tmp/opal-version-scroll-before.png
- /tmp/opal-version-scroll-after.png

Viewport: 319 × 800 CSS pixels, density 1, with eight sample versions and a sample audio-metadata response (48 kHz, 24-bit, WAV, 44.57 MB).
Cause: the dialog scrolled as a whole, and the generic .import-prompt p max-width limited metadata to 340px without centering that paragraph.
Fixes: fixed viewport-bounded dialog height, grid rows with minmax(0, 1fr) for the version list, independent list overflow and keyboard focus, fixed footer row, and a scoped full-width centered audio summary. New imports scroll their pending card into view.
Visual comparison included the source plus the before/after scroll captures together.
Scrolled the actual component preview from versions 1–3 to versions 6–8. Both footer buttons retained the same position and remained fully visible. Header and centered metadata also retained position.
The preview uses sample props, with native audio playback unavailable. Shorter native desktop windows have compact spacing styles; that viewport was not separately captured.
final result: passed
