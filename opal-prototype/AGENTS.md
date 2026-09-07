# OPAL development notes

Keep frontend work in `src/`. For UI changes, run the local preview and inspect the rendered result before considering the work finished.

When a supplied visual reference governs a change, treat it as the source of truth for composition, spacing, density, colour, typography, and visible content. Keep the OPAL atmosphere dark, plum-violet, art-led, and quiet.

The Sites handoff depends on `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs`; keep their contract intact. Before a Sites handoff, run `npm run build` and `npm run test:sites`. The build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

The current desktop direction is a centred sleeve carousel, a compact floating player, warm ivory type, and lavender glass. Responsive layouts may simplify the composition, but should keep the same mood and hierarchy.
