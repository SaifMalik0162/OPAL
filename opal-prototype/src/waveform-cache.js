import { waveformSeed } from "./waveform.js";

const WAVEFORM_CACHE_KEY = "opal-waveform-cache-v2";

function readCache() {
  try {
    return JSON.parse(window.localStorage.getItem(WAVEFORM_CACHE_KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

function writeCache(cache) {
  try {
    window.localStorage.setItem(WAVEFORM_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // A full or unavailable local store should never interrupt playback.
  }
}

export function readCachedWaveform(track) {
  if (!track?.id || typeof window === "undefined") return null;
  const entry = readCache()[track.id];
  if (!entry || entry.seed !== waveformSeed(track) || !Array.isArray(entry.bars)) return null;
  return entry.bars;
}

export function writeCachedWaveform(track, bars) {
  if (!track?.id || !Array.isArray(bars) || typeof window === "undefined") return;
  const cache = readCache();
  cache[track.id] = { seed: waveformSeed(track), bars };
  writeCache(cache);
}
