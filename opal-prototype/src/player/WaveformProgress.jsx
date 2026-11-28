import { useId } from "react";
import { useWaveform } from "./useWaveform.js";

function defaultFormatTime(durationMs) {
  if (!durationMs || durationMs < 0) return "0:00";
  const seconds = Math.floor(durationMs / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

const MOMENT_LABELS = { keep: "Keep", change: "Change", question: "Question", idea: "Idea" };
const defaultMomentStateLabel = (state) => MOMENT_LABELS[state] ?? "Question";
const safeId = (id) => id.replace(/[^a-zA-Z0-9_-]/g, "");

export function WaveformProgress({ id, track, progress, durationMs, showWaveform, moments = [], selectedMomentId, onChange, onSelectMoment, onCreateMoment, formatTime = defaultFormatTime, momentStateLabel = defaultMomentStateLabel }) {
  const generatedId = useId();
  const sliderId = id ?? `waveform-${safeId(generatedId)}`;
  const { bars, status: analysisState } = useWaveform(track, showWaveform);
  const safeProgress = Math.max(0, Math.min(100, Number(progress) || 0));
  const renderBars = (layer) => bars.map((height, index) => <span key={`${layer}-${index}`} style={{ height: `${height}%` }} />);
  const waveformReady = showWaveform && analysisState === "ready";

  return <div className={`waveform-progress${waveformReady ? " is-waveform" : ""}`} style={{ "--waveform-progress": `${safeProgress}%` }} role="group" aria-label="Playback waveform" onContextMenu={(event) => {
    if (event.target?.closest?.(".moment-marker")) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!durationMs || !onCreateMoment || bounds.width <= 0) return;
    const position = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    onCreateMoment(position * durationMs);
  }}>
    {waveformReady && <>
      <div className="waveform-layer waveform-layer-muted" aria-hidden="true">{renderBars("muted")}</div>
      <div className="waveform-layer waveform-layer-active" aria-hidden="true">{renderBars("active")}</div>
    </>}
    {showWaveform && !waveformReady && <span className={`waveform-analysis is-${analysisState}`} role="status">{analysisState === "loading" ? "Analyzing waveform" : "Waveform unavailable"}</span>}
    <span className="waveform-cursor" aria-hidden="true" />
    {moments.filter((moment) => durationMs > 0 && moment.timeMs >= 0 && moment.timeMs <= durationMs).map((moment) => <button type="button" key={moment.id} className={`moment-marker state-${moment.state} ${moment.isResolved ? "is-resolved" : ""} ${selectedMomentId === moment.id ? "is-selected" : ""}`} style={{ left: `${(moment.timeMs / durationMs) * 100}%` }} onClick={(event) => { event.stopPropagation(); onSelectMoment?.(moment); }} aria-label={`${momentStateLabel(moment.state)} moment at ${formatTime(moment.timeMs)}`} title={`${momentStateLabel(moment.state)} · ${formatTime(moment.timeMs)}`} />)}
    <input id={sliderId} className="waveform-input" aria-label="Playback position" title={onCreateMoment ? "Click or drag to seek · Right-click to add a moment · Press M at the playhead" : "Click or drag to seek"} type="range" min="0" max="100" step="any" aria-valuetext={`${formatTime(durationMs * safeProgress / 100)} of ${formatTime(durationMs)}`} value={safeProgress} onChange={onChange} disabled={!durationMs || !onChange} />
  </div>;
}
