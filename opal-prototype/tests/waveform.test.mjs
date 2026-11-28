import test from "node:test";
import assert from "node:assert/strict";
import { waveformSeed } from "../src/waveform.js";
import { createWaveformRepository, readCachedWaveform, writeCachedWaveform } from "../src/waveform-cache.js";

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

test("same-track waveform requests share one in-flight analysis", async () => {
  const repository = createWaveformRepository({ getItem: () => null, setItem: () => {} });
  const track = { id: "shared", title: "Shared", durationMs: 20_000, format: "WAV" };
  let resolveAnalysis;
  let analysisCount = 0;
  const analyze = () => {
    analysisCount += 1;
    return new Promise((resolve) => { resolveAnalysis = resolve; });
  };

  const first = repository.load(track, analyze);
  const second = repository.load({ ...track }, analyze);
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(analysisCount, 1);
  resolveAnalysis([12, 40, 88]);
  assert.deepEqual(await first, [12, 40, 88]);
  assert.deepEqual(repository.read(track), [12, 40, 88]);
});

test("changed track seed invalidates cache and stale analysis cannot replace the newer waveform", async () => {
  const values = new Map();
  const repository = createWaveformRepository({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  });
  const oldTrack = { id: "replaced", title: "Old title", durationMs: 20_000, format: "WAV" };
  const newTrack = { ...oldTrack, title: "New title" };
  let finishOld;
  let finishNew;
  const oldRequest = repository.load(oldTrack, () => new Promise((resolve) => { finishOld = resolve; }));
  const newRequest = repository.load(newTrack, () => new Promise((resolve) => { finishNew = resolve; }));

  await Promise.resolve();
  finishNew([80, 90]);
  assert.deepEqual(await newRequest, [80, 90]);
  finishOld([10, 20]);
  assert.deepEqual(await oldRequest, [10, 20]);
  assert.equal(repository.read(oldTrack), null);
  assert.deepEqual(repository.read(newTrack), [80, 90]);
});

test("explicit invalidation blocks stale in-flight writes and permits a fresh same-seed analysis", async () => {
  const values = new Map();
  const repository = createWaveformRepository({
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  });
  const track = { id: "invalidated", title: "Invalidated", durationMs: 20_000, format: "WAV" };
  let finishStale;
  let finishFresh;
  const staleRequest = repository.load(track, () => new Promise((resolve) => { finishStale = resolve; }));
  await Promise.resolve();
  repository.invalidate(track.id);
  const freshRequest = repository.load(track, () => new Promise((resolve) => { finishFresh = resolve; }));

  assert.notEqual(freshRequest, staleRequest);
  await Promise.resolve();
  finishFresh([70, 85]);
  assert.deepEqual(await freshRequest, [70, 85]);
  finishStale([10, 25]);
  assert.deepEqual(await staleRequest, [10, 25]);
  assert.deepEqual(repository.read(track), [70, 85]);
});
