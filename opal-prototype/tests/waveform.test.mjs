import test from "node:test";
import assert from "node:assert/strict";
import { createWaveform, waveformFromAudioBuffer, waveformSeed } from "../src/waveform.js";

test("waveform previews are stable and bounded for a track", () => {
  const track = { id: "track-1", title: "A song", durationMs: 185000, format: "MP3" };
  const first = createWaveform(waveformSeed(track), 72);
  const second = createWaveform(waveformSeed(track), 72);

  assert.deepEqual(first, second);
  assert.equal(first.length, 72);
  assert.ok(first.every((height) => height >= 18 && height <= 96));
});

test("different tracks receive different preview shapes", () => {
  const first = createWaveform(waveformSeed({ id: "one", title: "One" }), 24);
  const second = createWaveform(waveformSeed({ id: "two", title: "Two" }), 24);

  assert.notDeepEqual(first, second);
});

test("audio buffer peaks are converted into the visible waveform shape", () => {
  const audioBuffer = {
    length: 8,
    numberOfChannels: 1,
    getChannelData: () => Float32Array.from([0, 0.04, 0.16, 0.3, 0.55, 0.72, 0.88, 1]),
  };
  const bars = waveformFromAudioBuffer(audioBuffer, 4);

  assert.equal(bars.length, 4);
  assert.ok(bars[0] < bars[3]);
  assert.ok(bars.every((height) => height >= 18 && height <= 96));
});
