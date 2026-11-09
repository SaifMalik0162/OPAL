function formatLabel(format = "") {
  const normalized = String(format).trim().toUpperCase();
  if (!normalized) return "this audio";
  return normalized === "M4A" ? "M4A/AAC" : normalized;
}

export function playbackErrorMessage({ code, rejectionName, format } = {}) {
  const label = formatLabel(format);
  if (code === 2) return "OPAL couldn’t read this managed audio file. It may be missing or unavailable; import the original again.";
  if (code === 3) return `This ${label} file appears damaged or incomplete. Check the original file, then import it again.`;
  if (code === 4 || rejectionName === "NotSupportedError") {
    return `This computer couldn’t decode ${label} audio. Convert it to WAV, MP3, or AAC M4A and import it again.`;
  }
  if (rejectionName === "NotAllowedError") return "Playback was blocked by the audio output. Reconnect your speakers or headphones, then press Play again.";
  if (code === 1) return "Playback was interrupted. Press Play to continue.";
  return "OPAL couldn’t start this audio. Check the file and audio output, then try again.";
}
