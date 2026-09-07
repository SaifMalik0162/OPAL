function hashSeed(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function nextRandom(seed) {
  let next = seed + 0x6d2b79f5;
  next = Math.imul(next ^ (next >>> 15), next | 1);
  next ^= next + Math.imul(next ^ (next >>> 7), next | 61);
  return { seed: next >>> 0, value: ((next ^ (next >>> 14)) >>> 0) / 4294967296 };
}

/**
 * Creates a stable, track-specific preview shape for the player.
 * A real PCM analysis can be added without changing the waveform component's
 * visual contract when native metadata extraction grows to expose samples.
 */
export function createWaveform(seedValue, length = 72) {
  const count = Math.max(1, Math.floor(length));
  let seed = hashSeed(String(seedValue ?? "opal"));
  const bars = [];
  let previous = 0.48;
  for (let index = 0; index < count; index += 1) {
    const random = nextRandom(seed);
    seed = random.seed;
    const envelope = 0.46 + (0.34 * Math.sin((index / count) * Math.PI));
    const pulse = 0.5 + (0.5 * Math.sin(index * 0.82 + (random.value * 2.4)));
    const target = 0.16 + (envelope * (0.34 + (pulse * 0.66)));
    previous = (previous * 0.36) + (target * 0.64);
    bars.push(Math.round(Math.max(18, Math.min(96, previous * 100))));
  }
  return bars;
}

export function waveformFromAudioBuffer(audioBuffer, length = 72) {
  const count = Math.max(1, Math.floor(length));
  const sampleLength = Number(audioBuffer?.length) || 0;
  const channelCount = Number(audioBuffer?.numberOfChannels) || 0;
  if (!sampleLength || !channelCount || typeof audioBuffer.getChannelData !== "function") return [];

  const channels = Array.from({ length: channelCount }, (_, channel) => audioBuffer.getChannelData(channel));
  return Array.from({ length: count }, (_, index) => {
    const start = Math.floor((index / count) * sampleLength);
    const end = Math.max(start + 1, Math.floor(((index + 1) / count) * sampleLength));
    let peak = 0;
    for (let sample = start; sample < end; sample += 1) {
      for (const channel of channels) peak = Math.max(peak, Math.abs(channel[sample] || 0));
    }
    return Math.round(Math.max(18, Math.min(96, 18 + (Math.sqrt(peak) * 78))));
  });
}

export function waveformSeed(track) {
  return [track?.id, track?.title, track?.durationMs, track?.format].filter(Boolean).join(":") || "opal";
}
