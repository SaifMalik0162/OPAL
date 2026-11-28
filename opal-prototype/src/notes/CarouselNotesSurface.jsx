import React, { useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowCounterClockwise, Check, NotePencil } from "@phosphor-icons/react";
import { noteKeyForContext } from "../note-store.js";
import { useNoteContext } from "./useNoteContext.js";
import { flushBeforeNoteTransition } from "./safe-transition.js";

function formatMomentTime(durationMs) {
  const seconds = Math.floor(Math.max(0, Number(durationMs) || 0) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function groupNoteVersions(project) {
  const groups = new Map();
  for (const track of project.tracks ?? []) {
    const id = track.groupId ?? track.id;
    const group = groups.get(id) ?? { id, title: track.title, versions: [] };
    group.versions.push(track);
    groups.set(id, group);
  }
  return [...groups.values()];
}

export function CarouselNotesSurface({ project, manager, nativeAvailable, preferredTargetId, onFlushNotes, onClose, editorRef, retryRef, closeRef }) {
  const versions = useMemo(() => groupNoteVersions(project), [project]);
  const validTargetIds = useMemo(() => new Set((project.tracks ?? []).map((track) => track.id)), [project]);
  const [targetId, setTargetId] = useState(() => validTargetIds.has(preferredTargetId) ? preferredTargetId : "project");
  const [transitionError, setTransitionError] = useState(false);
  const transitionIdRef = useRef(0);
  const pendingCommitRef = useRef(null);
  const focusRetryAfterRenderRef = useRef(false);
  const key = noteKeyForContext({ projectId: project.id, targetId });
  const noteTrack = targetId === "project" ? null : project.tracks.find((track) => track.id === targetId) ?? null;
  const persistedText = targetId === "project" ? project.projectNote?.text ?? "" : noteTrack?.note?.text ?? "";
  const note = useNoteContext({
    manager,
    key,
    persistedText,
    onDebouncedSave: onFlushNotes,
    journalDraft: nativeAvailable,
  });
  const moments = noteTrack?.moments ?? [];
  const showRetry = transitionError || note.status === "error";

  useLayoutEffect(() => {
    if (!focusRetryAfterRenderRef.current || !showRetry) return;
    focusRetryAfterRenderRef.current = false;
    retryRef?.current?.focus({ preventScroll: true });
  }, [retryRef, showRetry]);

  async function flushThen(commit) {
    const transitionId = ++transitionIdRef.current;
    pendingCommitRef.current = commit ?? null;
    setTransitionError(false);
    const flushed = await flushBeforeNoteTransition({
      cancelDebounce: note.cancelDebounce,
      flush: onFlushNotes ?? (() => true),
      commit: () => {
        if (transitionId !== transitionIdRef.current) return;
        pendingCommitRef.current = null;
        setTransitionError(false);
        commit?.();
      },
      onFailure: () => {
        if (transitionId !== transitionIdRef.current) return;
        focusRetryAfterRenderRef.current = true;
        setTransitionError(true);
      },
    });
    return flushed && transitionId === transitionIdRef.current;
  }

  function changeTarget(nextTargetId) {
    if (nextTargetId === targetId) return;
    void flushThen(() => setTargetId(nextTargetId));
  }

  function retrySave() {
    const commit = pendingCommitRef.current ?? (() => editorRef?.current?.focus({ preventScroll: true }));
    void flushThen(commit);
  }

  closeRef.current = () => { void flushThen(onClose); };

  return <section className="carousel-notes-surface" id="library-notes-surface" role="region" aria-labelledby="library-notes-title">
    <img className="carousel-notes-art" src={project.artwork} alt="" draggable="false" />
    <div className="carousel-notes-wash" aria-hidden="true" />
    <header className="carousel-notes-header">
      <div className="carousel-notes-heading">
        <NotePencil size={16} aria-hidden="true" />
        <div><h2 id="library-notes-title">Notes</h2><small>{project.title}</small></div>
      </div>
      <button className="carousel-notes-cover" type="button" onClick={() => closeRef.current?.()} aria-label="Return to cover">
        <ArrowCounterClockwise size={14} aria-hidden="true" /><span>Cover</span>
      </button>
    </header>
    <div className="carousel-notes-scroll">
      <label className="carousel-notes-context">
        <span>Scope</span>
        <select aria-label="Note context" value={targetId} onChange={(event) => changeTarget(event.target.value)}>
          <option value="project">Project</option>
          {versions.map((group) => <optgroup key={group.id} label={group.title}>
            {group.versions.map((version) => <option key={version.id} value={version.id}>{version.versionName || "Original"}</option>)}
          </optgroup>)}
        </select>
      </label>
      <textarea
        ref={editorRef}
        className="carousel-notes-input"
        aria-label={`${targetId === "project" ? "Project" : `${noteTrack?.title ?? "Version"} · ${noteTrack?.versionName || "Original"}`} notes`}
        aria-describedby={nativeAvailable ? undefined : "carousel-notes-desktop-hint"}
        value={note.text}
        onChange={(event) => note.update(event.target.value)}
        placeholder={targetId === "project" ? "A thought to keep with this project…" : "A note for this version…"}
        spellCheck="true"
        disabled={!nativeAvailable}
      />
      {!nativeAvailable && <p className="carousel-notes-desktop-hint" id="carousel-notes-desktop-hint">Open OPAL desktop to edit and save notes.</p>}
      {noteTrack && <section className="carousel-notes-moments" aria-label={`Moments on ${noteTrack.title}`}>
        <div className="carousel-notes-moments-heading"><span>Moments</span><span>{moments.length}</span></div>
        {moments.length ? <ol>{moments.map((moment) => <li key={moment.id}>
          <time>{formatMomentTime(moment.timeMs)}</time>
          <span>{moment.text?.trim() || "No note yet"}</span>
          {moment.isResolved && <small>Resolved</small>}
        </li>)}</ol> : <p>No moments on this version yet.</p>}
      </section>}
    </div>
    <footer className="carousel-notes-footer">
      <span className={`carousel-notes-status is-${showRetry ? "error" : note.status}`} role="status" aria-live="polite">{showRetry ? "Couldn’t save" : note.status === "saving" ? "Saving" : <><Check size={12} aria-hidden="true" />Saved</>}</span>
      <button ref={retryRef} type="button" className={`carousel-notes-retry${showRetry ? " is-visible" : ""}`} onClick={retrySave} aria-hidden={!showRetry} tabIndex={showRetry ? 0 : -1} disabled={!showRetry}>Retry</button>
      <small>{nativeAvailable ? "Autosaves as you write" : "Desktop only"}</small>
    </footer>
  </section>;
}
