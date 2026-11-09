import test from "node:test";
import assert from "node:assert/strict";
import { waveformSeed } from "../src/waveform.js";
import { readCachedWaveform, writeCachedWaveform } from "../src/waveform-cache.js";

const values = new Map();
globalThis.window = {
  localStorage: {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  },
};

test("waveform cache keys follow the track identity and audio metadata", () => {
  const original = { id: "track", title: "Night Walk", durationMs: 120_000, format: "FLAC" };
  assert.equal(waveformSeed(original), "track:Night Walk:120000:FLAC");
  assert.notEqual(waveformSeed(original), waveformSeed({ ...original, durationMs: 121_000 }));
});

test("the cache stores and returns measured bars for the matching track", () => {
  values.clear();
  const track = { id: "measured", title: "Measured audio", durationMs: 40_000, format: "WAV" };
  const measuredBars = [18, 47, 96, 58];

  writeCachedWaveform(track, measuredBars);

  assert.deepEqual(readCachedWaveform(track), measuredBars);
  assert.equal(readCachedWaveform({ ...track, durationMs: 41_000 }), null);
});

test("empty or malformed cache values are ignored", () => {
  values.set("opal-waveform-cache-v1", JSON.stringify({ broken: { seed: "x", bars: "not-bars" } }));
  assert.equal(readCachedWaveform({ id: "broken" }), null);
});
