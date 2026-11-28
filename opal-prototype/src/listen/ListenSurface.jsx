import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDown,
  Check,
  ListBullets,
  NotePencil,
  Pause,
  Play,
  Repeat,
  RepeatOnce,
  Shuffle,
  SkipBack,
  SkipForward,
  SpeakerHigh,
  SpeakerX,
  X,
} from "@phosphor-icons/react";
import { useOverlayLayer } from "../useOverlayLayer.js";
import { WaveformProgress } from "../player/WaveformProgress.jsx";
import { clampPreviewPosition } from "./listen-state.js";
import "./listen.css";

function formatListenTime(durationMs) {
  const seconds = Math.floor(Math.max(0, Number(durationMs) || 0) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function safeOriginValue(value) {
  return Number.isFinite(value) ? Math.round(value * 100) / 100 : 0;
}

export function ListenSurface({
  transition,
  binding,
  project,
  track,
  playbackProject,
  playbackTrack,
  playbackState,
  playbackError,
  elapsedMs,
  durationMs,
  queue,
  queueIndex,
  volume,
  muted,
  shuffleEnabled,
  repeatMode,
  utility,
  originRect,
  nativeAvailable,
  onClose,
  onOpened,
  onClosed,
  onPlayDisplayed,
  onTogglePlayback,
  onPrevious,
  onNext,
  onBrowsePreview,
  onPreviewSeek,
  onPlaybackSeek,
  onToggleShuffle,
  onToggleRepeat,
  onOpenUtility,
  onCloseUtility,
  onVolumeChange,
  onToggleMute,
  onSelectQueueTrack,
  onCreateMoment,
}) {
  const surfaceRef = useRef(null);
  const collapseRef = useRef(null);
  const utilityTriggerRef = useRef(null);
  const momentTextareaRef = useRef(null);
  const utilityBeforeCloseRef = useRef("closed");
  const onCloseRef = useRef(onClose);
  const onCloseUtilityRef = useRef(onCloseUtility);
  onCloseRef.current = onClose;
  onCloseUtilityRef.current = onCloseUtility;
  const seekId = `listen-seek-${useId().replace(/:/g, "")}`;
  const [momentDraft, setMomentDraft] = useState("");
  const [momentTarget, setMomentTarget] = useState(null);
  const [momentStatus, setMomentStatus] = useState("");
  const [savingMoment, setSavingMoment] = useState(false);

  useOverlayLayer({
    elementRef: surfaceRef,
    modal: true,
    trapFocus: true,
    getInitialFocus: () => collapseRef.current,
    onEscape: () => {
      if (utility?.type && utility.type !== "closed") {
        utilityBeforeCloseRef.current = utility.type;
        onCloseUtilityRef.current?.();
        window.requestAnimationFrame(() => utilityTriggerRef.current?.focus({ preventScroll: true }));
      } else {
        onCloseRef.current?.();
      }
    },
  });

  useEffect(() => {
    if (transition !== "opening" && transition !== "closing") return undefined;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const delay = reducedMotion ? 0 : transition === "opening" ? 320 : 190;
    const timer = window.setTimeout(() => {
      if (transition === "opening") onOpened?.();
      else onClosed?.();
    }, delay);
    return () => window.clearTimeout(timer);
  }, [onClosed, onOpened, transition]);

  useEffect(() => {
    if (utility?.type === "moment-composer") momentTextareaRef.current?.focus({ preventScroll: true });
    if (utility?.type === "queue") surfaceRef.current?.querySelector(".listen-queue-close")?.focus({ preventScroll: true });
    if (utility?.type === "volume") surfaceRef.current?.querySelector(".listen-volume-close")?.focus({ preventScroll: true });
  }, [utility?.type]);

  useEffect(() => {
    if (utility?.type !== "closed" || utilityBeforeCloseRef.current === "closed") return;
    const trigger = utilityTriggerRef.current;
    utilityBeforeCloseRef.current = "closed";
    window.requestAnimationFrame(() => trigger?.focus({ preventScroll: true }));
  }, [utility?.type]);

  const isPreview = binding?.type === "preview";
  const displayDurationMs = isPreview ? Math.max(0, Number(track?.durationMs) || 0) : Math.max(0, Number(durationMs) || Number(track?.durationMs) || 0);
  const displayElapsedMs = isPreview
    ? clampPreviewPosition(binding?.pendingSeekMs, displayDurationMs)
    : Math.min(displayDurationMs || Number.MAX_SAFE_INTEGER, Math.max(0, Number(elapsedMs) || 0));
  const progress = displayDurationMs > 0 ? (displayElapsedMs / displayDurationMs) * 100 : 0;
  const hasOtherPlayback = Boolean(playbackProject && playbackTrack && (playbackProject.id !== project?.id || playbackTrack.id !== track?.id));
  const isPlaying = !isPreview && playbackState === "playing";
  const repeatLabel = repeatMode === "track" ? "Repeat track" : repeatMode === "project" ? "Repeat project" : "Repeat off";
  const primaryLabel = isPreview ? `Play ${track?.title ?? "track"}` : isPlaying ? "Pause" : playbackState === "error" ? "Retry playback" : "Play";
  const originStyle = originRect ? {
    "--listen-origin-x": `${safeOriginValue(originRect.x)}px`,
    "--listen-origin-y": `${safeOriginValue(originRect.y)}px`,
    "--listen-origin-width": `${safeOriginValue(originRect.width)}px`,
    "--listen-origin-height": `${safeOriginValue(originRect.height)}px`,
  } : undefined;

  function closeUtility() {
    utilityBeforeCloseRef.current = utility?.type ?? "closed";
    onCloseUtility?.();
    window.requestAnimationFrame(() => utilityTriggerRef.current?.focus({ preventScroll: true }));
  }

  function openMomentComposer(timeMs = displayElapsedMs) {
    if (!project || !track) return;
    setMomentTarget({ project, track, timeMs: clampPreviewPosition(timeMs, displayDurationMs) });
    setMomentStatus("");
    onOpenUtility?.("moment-composer");
  }

  async function saveMoment() {
    if (!momentTarget || savingMoment) return;
    setSavingMoment(true);
    setMomentStatus("");
    try {
      const saved = await onCreateMoment?.(momentTarget.project, momentTarget.track, momentTarget.timeMs, momentDraft);
      if (saved) {
        setMomentDraft("");
        setMomentTarget(null);
        closeUtility();
      } else {
        setMomentStatus("Couldn’t save this moment. Your draft is still here.");
      }
    } catch {
      setMomentStatus("Couldn’t save this moment. Your draft is still here.");
    } finally {
      setSavingMoment(false);
    }
  }

  function handlePositionChange(event) {
    const position = displayDurationMs * (Number(event.target.value) / 100);
    if (isPreview) onPreviewSeek?.(position, displayDurationMs);
    else onPlaybackSeek?.(event);
  }

  if (typeof document === "undefined") return null;
  const surface = <section
    ref={surfaceRef}
    id="listen-surface"
    data-overlay-layer
    data-listen-surface
    data-transition={transition}
    data-listen-utility={utility?.type ?? "closed"}
    data-has-origin={originRect ? "true" : undefined}
    data-origin-x={originRect ? safeOriginValue(originRect.x) : undefined}
    data-origin-y={originRect ? safeOriginValue(originRect.y) : undefined}
    data-origin-width={originRect ? safeOriginValue(originRect.width) : undefined}
    data-origin-height={originRect ? safeOriginValue(originRect.height) : undefined}
    style={originStyle}
    className="listen-surface"
    role="dialog"
    aria-modal="true"
    aria-labelledby="listen-track-title"
    tabIndex={-1}
  >
    <img className="listen-atmosphere" src={project?.artwork} alt="" aria-hidden="true" />
    <div className="listen-veil" aria-hidden="true" />
    <header className="listen-header">
      <div className="listen-project-context">
        <img src={project?.artwork} alt="" />
        <span><strong>{project?.title ?? "Listen"}</strong><small>{isPreview ? "Preview" : "Now playing"}</small></span>
      </div>
      <button ref={collapseRef} type="button" className="listen-collapse" onClick={onClose} aria-label="Collapse Listen">
        <ArrowDown size={16} aria-hidden="true" /><span>Collapse</span>
      </button>
    </header>

    <main className="listen-main">
      {project && track ? <>
        <div className="listen-artwork-frame" data-listen-artwork>
          <img src={project.artwork} alt={`${project.title} artwork`} />
        </div>
        <div className="listen-track-copy">
          <p className="listen-track-eyebrow">{track.versionName ?? "Original"}</p>
          <h1 id="listen-track-title">{track.title}</h1>
          <p>{project.title}</p>
        </div>
        {isPreview && hasOtherPlayback && <div className="listen-playing-from" role="status">
          <span>{playbackState === "playing" ? `Playing from ${playbackProject.title}` : `Playback is on ${playbackProject.title}`}</span>
          <button type="button" onClick={() => onBrowsePreview?.("playback")}>Go to playing</button>
        </div>}
        {isPreview && !hasOtherPlayback && <p className="listen-preview-status" role="status">Ready to listen</p>}
        {!isPreview && playbackError && <p className="listen-playback-error" role="alert">{playbackError}</p>}
        {!nativeAvailable && <p className="listen-playback-hint" role="status">Open the native OPAL app to play local audio.</p>}
        {nativeAvailable && !track.managedFilePath && <p className="listen-playback-hint" role="status">Audio file unavailable. Restore the track file, then try again.</p>}
      </> : <div className="listen-empty-state">
        <h1 id="listen-track-title">This track is unavailable</h1>
        <p>Choose another track from the library, then open Listen again.</p>
      </div>}
    </main>

    <footer className="listen-controls">
      <div className="listen-waveform-row">
        <time>{formatListenTime(displayElapsedMs)}</time>
        {project && track ? <WaveformProgress
          id={seekId}
          track={track}
          progress={progress}
          durationMs={displayDurationMs}
          showWaveform={true}
          moments={track.moments ?? []}
          onChange={handlePositionChange}
          onCreateMoment={openMomentComposer}
          formatTime={formatListenTime}
        /> : <div className="listen-waveform-placeholder" role="status">No track selected</div>}
        <time>{formatListenTime(displayDurationMs)}</time>
      </div>
      {!displayDurationMs && project && track && <p className="listen-duration-fallback" role="status">Track duration is unavailable. Seeking will be enabled when metadata is available.</p>}
      <div className="listen-transport">
        <div className="listen-transport-side listen-transport-left">
          <button type="button" className={shuffleEnabled ? "is-on" : ""} onClick={onToggleShuffle} title={shuffleEnabled ? "Turn shuffle off" : "Turn shuffle on"} aria-label={shuffleEnabled ? "Turn shuffle off for current playback" : "Turn shuffle on for current playback"} aria-pressed={shuffleEnabled}><Shuffle size={19} /></button>
          <button type="button" className={repeatMode !== "off" ? "is-on" : ""} onClick={onToggleRepeat} title={repeatLabel} aria-label={repeatLabel} aria-pressed={repeatMode !== "off"}>{repeatMode === "track" ? <RepeatOnce size={19} /> : <Repeat size={19} />}</button>
        </div>
        <div className="listen-primary-transport">
          <button type="button" onClick={() => isPreview ? onBrowsePreview?.(-1) : onPrevious?.()} disabled={!project || !track} title="Previous track" aria-label="Previous track"><SkipBack size={19} weight="fill" /></button>
          <button type="button" className={`listen-primary-play${isPreview ? " is-preview" : ""}`} onClick={() => isPreview ? onPlayDisplayed?.(project, track, displayElapsedMs) : onTogglePlayback?.()} disabled={!project || !track || (!isPreview && playbackState === "loading")} title={primaryLabel} aria-label={primaryLabel}>
            {isPlaying ? <Pause size={23} weight="fill" /> : <Play size={23} weight="fill" />}
            {isPreview && <span>{primaryLabel}</span>}
          </button>
          <button type="button" onClick={() => isPreview ? onBrowsePreview?.(1) : onNext?.()} disabled={!project || !track} title="Next track" aria-label="Next track"><SkipForward size={19} weight="fill" /></button>
        </div>
        <div className="listen-transport-side listen-transport-right">
          <button
            ref={utility?.type === "queue" ? utilityTriggerRef : undefined}
            type="button"
            className={utility?.type === "queue" ? "is-on" : ""}
            onClick={(event) => { utilityTriggerRef.current = event.currentTarget; onOpenUtility?.("queue"); }}
            aria-label={hasOtherPlayback ? `Open queue for ${playbackProject.title}` : "Open playback queue"}
            aria-expanded={utility?.type === "queue"}
            title={hasOtherPlayback ? `Current queue · ${playbackProject.title}` : "Current playback queue"}
          ><ListBullets size={19} /></button>
          <button
            ref={utility?.type === "moment-composer" ? utilityTriggerRef : undefined}
            type="button"
            className={utility?.type === "moment-composer" ? "is-on" : ""}
            onClick={(event) => { utilityTriggerRef.current = event.currentTarget; openMomentComposer(); }}
            aria-label="Add a moment at this position"
            aria-expanded={utility?.type === "moment-composer"}
            title="Add moment"
            disabled={!project || !track || !displayDurationMs}
          ><NotePencil size={19} /></button>
          <button
            ref={utility?.type === "volume" ? utilityTriggerRef : undefined}
            type="button"
            className={utility?.type === "volume" ? "is-on" : ""}
            onClick={(event) => { utilityTriggerRef.current = event.currentTarget; onOpenUtility?.("volume"); }}
            aria-label={utility?.type === "volume" ? "Close global volume" : "Open global volume"}
            aria-expanded={utility?.type === "volume"}
            title="Global volume"
          >{muted ? <SpeakerX size={19} /> : <SpeakerHigh size={19} />}</button>
        </div>
      </div>

      {utility?.type === "queue" && <section className="listen-utility-panel listen-queue-panel" role="region" aria-label="Current playback queue">
        <header><span><strong>Playback queue</strong><small>{playbackProject ? `Playing from ${playbackProject.title}` : "No active playback"}</small></span><button type="button" className="listen-queue-close" onClick={closeUtility} aria-label="Close playback queue"><X size={16} /></button></header>
        {playbackProject && playbackTrack && <div className="listen-queue-current"><small>Current track</small><strong>{playbackTrack.title}</strong><span>{playbackTrack.versionName ?? "Original"} · {playbackProject.title}</span></div>}
        <div className="listen-queue-list">
          {playbackProject && queue.slice(Math.max(0, queueIndex + 1)).map((item, index) => <button key={`${item.id}:${index}`} type="button" onClick={() => onSelectQueueTrack?.(item, queueIndex + index + 1)}>
            <span>{String(index + 1).padStart(2, "0")}</span><strong>{item.title}</strong><small>{formatListenTime(item.durationMs)}</small>
          </button>)}
          {(!playbackProject || queue.slice(Math.max(0, queueIndex + 1)).length === 0) && <p className="listen-queue-empty">{playbackProject ? "Nothing else is queued." : "Start a track to create a playback queue."}</p>}
        </div>
      </section>}

      {utility?.type === "volume" && <section className="listen-utility-panel listen-volume-panel" role="group" aria-label="Global volume">
        <header><span><strong>Global volume</strong><small>Controls the app’s audio output</small></span><button type="button" className="listen-volume-close" onClick={closeUtility} aria-label="Close global volume"><X size={16} /></button></header>
        <div className="listen-volume-control"><button type="button" onClick={onToggleMute} aria-label={muted ? "Unmute output" : "Mute output"}>{muted ? <SpeakerX size={18} /> : <SpeakerHigh size={18} />}</button><input aria-label="Global output volume" type="range" min="0" max="100" value={muted ? 0 : volume} onChange={onVolumeChange} /><span>{muted ? "Muted" : `${Math.round(volume)}%`}</span></div>
      </section>}

      {utility?.type === "moment-composer" && <section className="listen-utility-panel listen-moment-panel" role="region" aria-label="Add a listening moment">
        <header><span><strong>Add a moment</strong><small>{momentTarget ? `${momentTarget.track.title} · ${formatListenTime(momentTarget.timeMs)}` : "Current track"}</small></span><button type="button" onClick={closeUtility} aria-label="Close moment composer"><X size={16} /></button></header>
        <textarea ref={momentTextareaRef} value={momentDraft} onChange={(event) => setMomentDraft(event.target.value)} placeholder="What do you want to remember?" aria-label="Moment note" />
        <footer><span role="status">{momentStatus || "This moment will be saved to the selected track."}</span><button type="button" onClick={saveMoment} disabled={savingMoment || !momentTarget}>{savingMoment ? "Saving…" : "Add moment"}<Check size={14} /></button></footer>
      </section>}
    </footer>
  </section>;

  return createPortal(surface, document.body);
}
