export function waveformSeed(track) {
  return [track?.id, track?.title, track?.durationMs, track?.format].filter(Boolean).join(":") || "opal";
}
