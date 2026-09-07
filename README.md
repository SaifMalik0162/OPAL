# OPAL

OPAL is a local-first music library designed to make a personal collection feel collected, not catalogued.

The current product work lives in [`opal-prototype/`](opal-prototype/), a Vite + React prototype with a Tauri desktop foundation.

## Start the prototype

```bash
cd opal-prototype
npm install
npm run dev
```

## Verify

```bash
npm run test:sites
npm run test:playback
npm run test:waveform
npm run test:notes
npm run build
```

Additional focused test scripts are available in `opal-prototype/package.json`.
