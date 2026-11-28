import { useEffect, useState } from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { loadWaveform, waveformRequestKey } from "../waveform-cache.js";

export function useWaveform(track, enabled) {
  const key = waveformRequestKey(track);
  const trackId = track?.id;
  const title = track?.title;
  const durationMs = track?.durationMs;
  const format = track?.format;
  const managedFileRef = track?.managedFileRef;
  const [result, setResult] = useState({ key: "", bars: [], status: "loading" });

  useEffect(() => {
    if (!enabled || !key) return undefined;
    let current = true;
    setResult({ key, bars: [], status: "loading" });
    if (!isTauri() || !managedFileRef) {
      setResult({ key, bars: [], status: "unavailable" });
      return () => { current = false; };
    }

    loadWaveform(track, () => invoke("getAudioWaveform", { managedFileRef }))
      .then((bars) => {
        if (current) setResult({ key, bars: bars ?? [], status: bars?.length ? "ready" : "unavailable" });
      })
      .catch(() => {
        if (current) setResult({ key, bars: [], status: "unavailable" });
      });

    return () => { current = false; };
  }, [durationMs, enabled, format, key, managedFileRef, title, trackId]);

  if (result.key !== key) return { bars: [], status: enabled ? "loading" : "unavailable" };
  return enabled ? { bars: result.bars, status: result.status } : { bars: [], status: "unavailable" };
}
