import { waveformSeed } from "./waveform.js";

export const WAVEFORM_CACHE_KEY = "opal-waveform-cache-v2";

function browserStorage() {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function readCache(storage) {
  try {
    return JSON.parse(storage?.getItem(WAVEFORM_CACHE_KEY) ?? "{}") ?? {};
  } catch {
    return {};
  }
}

function writeCache(storage, cache) {
  try {
    storage?.setItem(WAVEFORM_CACHE_KEY, JSON.stringify(cache));
  } catch {
    // A full or unavailable local store should never interrupt playback.
  }
}

function normalizedBars(value) {
  return Array.from(value ?? [], (bar) => Number(bar)).filter(Number.isFinite);
}

export function waveformRequestKey(track) {
  return track?.id ? `${track.id}\u0000${waveformSeed(track)}` : "";
}

export function createWaveformRepository(storageProvider = browserStorage) {
  const memory = new Map();
  const inFlight = new Map();
  const activeSeedByTrack = new Map();
  const generationByTrack = new Map();

  function storage() {
    return typeof storageProvider === "function" ? storageProvider() : storageProvider;
  }

  function read(track) {
    if (!track?.id) return null;
    const seed = waveformSeed(track);
    const memoryEntry = memory.get(track.id);
    if (memoryEntry?.seed === seed && Array.isArray(memoryEntry.bars)) return memoryEntry.bars;
    const entry = readCache(storage())[track.id];
    if (!entry || entry.seed !== seed || !Array.isArray(entry.bars)) return null;
    memory.set(track.id, { seed, bars: entry.bars });
    return entry.bars;
  }

  function write(track, bars, expectedSeed = waveformSeed(track)) {
    if (!track?.id || !Array.isArray(bars)) return;
    const seed = waveformSeed(track);
    if (seed !== expectedSeed) return;
    const activeSeed = activeSeedByTrack.get(track.id);
    if (activeSeed && activeSeed !== seed) return;
    const safeBars = normalizedBars(bars);
    if (!safeBars.length) return;
    memory.set(track.id, { seed, bars: safeBars });
    const cache = readCache(storage());
    cache[track.id] = { seed, bars: safeBars };
    writeCache(storage(), cache);
  }

  function load(track, analyze) {
    if (!track?.id || typeof analyze !== "function") return Promise.resolve(null);
    const seed = waveformSeed(track);
    const requestKey = waveformRequestKey(track);
    const generation = generationByTrack.get(track.id) ?? 0;
    activeSeedByTrack.set(track.id, seed);
    const cached = read(track);
    if (cached?.length) return Promise.resolve(cached);
    if (inFlight.has(requestKey)) return inFlight.get(requestKey);

    const pending = Promise.resolve()
      .then(analyze)
      .then((result) => {
        const bars = normalizedBars(result);
        if (
          bars.length
          && (generationByTrack.get(track.id) ?? 0) === generation
          && activeSeedByTrack.get(track.id) === seed
        ) write(track, bars, seed);
        return bars.length ? bars : null;
      })
      .finally(() => {
        if (inFlight.get(requestKey) === pending) inFlight.delete(requestKey);
      });
    inFlight.set(requestKey, pending);
    return pending;
  }

  function invalidate(trackId) {
    generationByTrack.set(trackId, (generationByTrack.get(trackId) ?? 0) + 1);
    memory.delete(trackId);
    activeSeedByTrack.delete(trackId);
    const requestPrefix = `${trackId}\u0000`;
    for (const requestKey of inFlight.keys()) {
      if (requestKey.startsWith(requestPrefix)) inFlight.delete(requestKey);
    }
    const cache = readCache(storage());
    if (Object.hasOwn(cache, trackId)) {
      delete cache[trackId];
      writeCache(storage(), cache);
    }
  }

  return { read, write, load, invalidate, getInFlightCount: () => inFlight.size };
}

const waveformRepository = createWaveformRepository();

export function readCachedWaveform(track) {
  return waveformRepository.read(track);
}

export function writeCachedWaveform(track, bars) {
  waveformRepository.write(track, bars);
}

export function loadWaveform(track, analyze) {
  return waveformRepository.load(track, analyze);
}
