import React, { useEffect, useRef, useState } from "react";
import { ArrowCounterClockwise, CaretLeft, CaretRight, FolderOpen, ListBullets, MusicNote, Play } from "@phosphor-icons/react";

import { TrackPlaybackIndicator } from "./TrackPlaybackIndicator.jsx";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function ProjectsCarousel({ projects, index, onSelect, onOpen, onPlay, tracks, onPlayTrack, playingTrackId, isPlaying, progress }) {
  const stageRef = useRef(null);
  const coverRef = useRef(null);
  const previewToggleRef = useRef(null);
  const previewCloseRef = useRef(null);
  const gesture = useRef(null);
  const suppressClick = useRef(false);
  const wheel = useRef({ distance: 0, last: 0, lastStep: -Infinity, direction: 0 });
  const [drag, setDrag] = useState(0);
  const [previewProjectId, setPreviewProjectId] = useState(null);
  const project = projects[index];
  const previewOpen = previewProjectId === project.id;
  const artwork = `url(${JSON.stringify(project.artwork)})`;
  const titleSize = project.title.length > 74 ? "23px" : project.title.length > 56 ? "27px" : project.title.length > 42 ? "31px" : project.title.length > 30 ? "38px" : project.title.length > 20 ? "46px" : "clamp(28px, 4.1vw, 54px)";

  function selectProject(nextIndex) {
    if (nextIndex !== index) setPreviewProjectId(null);
    onSelect(nextIndex);
  }

  function closePreview() {
    setPreviewProjectId(null);
    previewToggleRef.current?.focus({ preventScroll: true });
  }

  useEffect(() => {
    setPreviewProjectId(null);
  }, [project.id]);

  useEffect(() => {
    if (previewOpen) previewCloseRef.current?.focus({ preventScroll: true });
  }, [previewOpen]);

  function step(offset) {
    selectProject(clamp(index + offset, 0, projects.length - 1));
  }

  useEffect(() => {
    const stage = stageRef.current;
    function onWheel(event) {
      if (event.ctrlKey || event.metaKey || event.target.closest(".projects-track-preview")) return;
      const horizontal = event.shiftKey ? event.deltaX || event.deltaY : event.deltaX;
      if (!horizontal || (!event.shiftKey && Math.abs(horizontal) <= Math.abs(event.deltaY))) return;
      event.preventDefault();
      const now = performance.now();
      const input = wheel.current;
      const direction = Math.sign(horizontal);
      if (now - input.last > 100 || direction !== input.direction) input.distance = 0;
      input.direction = direction;
      input.last = now;
      input.distance += Math.abs(horizontal) * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 100 : 1);
      if (input.distance < 28 || now - input.lastStep < 175) return;
      input.distance = 0;
      input.lastStep = now;
      const nextIndex = clamp(index + direction, 0, projects.length - 1);
      if (nextIndex !== index) setPreviewProjectId(null);
      onSelect(nextIndex);
    }
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [index, onSelect, projects.length]);

  function beginDrag(event) {
    if (!event.isPrimary || event.button !== 0) return;
    suppressClick.current = false;
    if (event.target.closest(".projects-track-preview") || projects.length < 2) return;
    // Capture on the pressed cover so a tap still clicks it, even though moves bubble to the stage.
    event.target.setPointerCapture(event.pointerId);
    gesture.current = {
      id: event.pointerId,
      start: event.clientX,
      startY: event.clientY,
      width: coverRef.current?.offsetWidth || 280,
      dragging: false,
    };
  }

  function moveDrag(event) {
    const active = gesture.current;
    if (!active || active.id !== event.pointerId) return;
    const distance = event.clientX - active.start;
    if (!active.dragging) {
      if (Math.abs(distance) < 8 || Math.abs(distance) <= Math.abs(event.clientY - active.startY)) return;
      active.dragging = true;
    }
    const direction = -distance / active.width;
    const atEdge = (index === 0 && direction < 0) || (index === projects.length - 1 && direction > 0);
    setDrag(clamp(direction * (atEdge ? 0.22 : 1), -1, 1));
  }

  function endDrag(event, cancelled = false) {
    const active = gesture.current;
    if (!active || active.id !== event.pointerId) return;
    gesture.current = null;
    setDrag(0);
    if (!active.dragging) return;
    suppressClick.current = true;
    const distance = active.start - event.clientX;
    if (!cancelled && Math.abs(distance) >= clamp(active.width * 0.1, 22, 42)) step(Math.sign(distance));
  }

  function handleKeys(event) {
    if (event.target.closest(".projects-track-preview")) return;
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    if (event.key === "ArrowLeft") step(-1);
    else if (event.key === "ArrowRight") step(1);
    else if (event.key === "Home") selectProject(0);
    else if (event.key === "End") selectProject(projects.length - 1);
    else if (event.key === "Enter" && event.target === event.currentTarget) onOpen(project.id);
    else return;
    event.preventDefault();
    event.stopPropagation();
  }

  const first = Math.max(0, index - 3);
  const covers = projects.slice(first, index + 4);
  const markerCount = Math.min(7, projects.length);
  const firstMarker = clamp(index - Math.floor(markerCount / 2), 0, projects.length - markerCount);
  const markerProjects = projects.slice(firstMarker, firstMarker + markerCount);
  return <div className="projects-carousel" data-preview-open={previewOpen} style={{ "--selected-artwork": artwork }} onKeyDown={(event) => {
    if (event.key === "Escape" && previewOpen) {
      event.preventDefault();
      event.stopPropagation();
      closePreview();
    }
  }}>
    <div
      ref={stageRef}
      className="projects-carousel-stage"
      role="region"
      aria-label="Project carousel. Use arrow keys to browse, Enter to open."
      tabIndex={0}
      data-dragging={drag !== 0}
      onKeyDown={handleKeys}
      onPointerDown={beginDrag}
      onPointerMove={moveDrag}
      onPointerUp={endDrag}
      onPointerCancel={(event) => endDrag(event, true)}
      onLostPointerCapture={(event) => endDrag(event, true)}
      onClickCapture={(event) => {
        if (!suppressClick.current || event.detail === 0) return;
        event.stopPropagation();
        suppressClick.current = false;
      }}
    >
      <div className="projects-carousel-light" key={project.artwork} aria-hidden="true" style={{ "--reflection-x": `${-drag * 54}%` }}>
        <img className="projects-carousel-ambient" src={project.artwork} alt="" draggable={false} />
        <span className="projects-carousel-reflection">
          <img src={project.artwork} alt="" draggable={false} />
        </span>
      </div>
      {covers.map((item, position) => {
        const itemIndex = first + position;
        const offset = itemIndex - index - drag;
        const depth = Math.abs(offset);
        const direction = Math.sign(offset);
        const spacing = Math.min(depth, 1) * 94 + Math.max(depth - 1, 0) * 60;
        const selected = itemIndex === index;
        const flipped = selected && previewOpen;
        return <div
          key={item.id}
          ref={selected ? coverRef : undefined}
          className="projects-carousel-cover"
          data-selected={selected}
          data-flipped={flipped}
          aria-hidden={Math.abs(itemIndex - index) > 2 ? "true" : undefined}
          style={{
            "--cover-x": `${direction * spacing}%`,
            "--cover-drop": `${Math.min(depth * 12, 25)}px`,
            "--cover-turn": `${direction * Math.min(depth * 38, 64)}deg`,
            "--cover-scale": Math.max(0.48, 1 - Math.min(depth, 1) * 0.16 - Math.max(depth - 1, 0) * 0.22),
            "--cover-opacity": clamp(depth <= 1 ? 1 - depth * 0.06 : 0.94 - (depth - 1) * 0.47, 0, 1),
            zIndex: 20 - Math.round(depth * 4),
          }}
        >
          <div className="projects-cover-turn">
            <button
              type="button"
              className="projects-cover-front"
              tabIndex={-1}
              inert={flipped}
              disabled={Math.abs(itemIndex - index) > 2}
              aria-current={selected ? "true" : undefined}
              aria-label={selected ? `Open ${item.title}` : `Select ${item.title}`}
              onClick={() => {
                if (selected) onOpen(item.id);
                else selectProject(itemIndex);
                stageRef.current?.focus({ preventScroll: true });
              }}
            ><img src={item.artwork} alt="" draggable={false} /></button>
            {selected && <section
              id="projects-track-preview"
              className="projects-track-preview"
              aria-label={`Tracks in ${project.title}`}
              inert={!flipped}
            >
              <img className="projects-preview-art" src={project.artwork} alt="" draggable={false} />
              <div className="projects-preview-header">
                <div><strong>Tracks</strong><span>{tracks.length}</span></div>
                <button ref={previewCloseRef} type="button" onClick={closePreview} aria-label="Return to cover"><ArrowCounterClockwise size={15} /></button>
              </div>
              {tracks.length ? <ol className="projects-preview-list">
                {tracks.map((track, trackIndex) => {
                  const current = track.id === playingTrackId;
                  return <li key={track.id}>
                    <button
                      type="button"
                      onClick={() => onPlayTrack(project, track)}
                      aria-label={`Play ${track.title}${track.versionName ? `, ${track.versionName}` : ""}`}
                      aria-current={current ? "true" : undefined}
                      style={current ? { "--track-progress": `${progress}%` } : undefined}
                    >
                      <span className="projects-preview-cue" aria-hidden="true">
                        {current && isPlaying
                          ? <TrackPlaybackIndicator />
                          : <><span className="projects-preview-index">{String(trackIndex + 1).padStart(2, "0")}</span><Play className="projects-preview-cue-play" size={11} weight="fill" /></>}
                      </span>
                      <span className="projects-preview-track-copy">
                        <strong title={track.title}>{track.title}</strong>
                        {track.versionName && <small>{track.versionName}</small>}
                      </span>
                      <span className="projects-preview-duration">{track.duration}</span>
                    </button>
                  </li>;
                })}
              </ol> : <div className="projects-preview-empty"><MusicNote size={23} weight="light" /><p>No tracks in this project yet.</p></div>}
            </section>}
          </div>
        </div>;
      })}
    </div>
    <div className="projects-carousel-caption">
      <div className="projects-carousel-navigation" role="group" aria-label="Browse projects" data-single={projects.length === 1}>
        <button className="projects-carousel-arrow" type="button" aria-label="Previous project" onClick={() => step(-1)} disabled={index === 0}><CaretLeft size={13} weight="light" /></button>
        <div className="projects-carousel-markers">
          {markerProjects.map((item, offset) => {
            const position = firstMarker + offset;
            return <button
              key={item.id}
              className="projects-carousel-marker"
              type="button"
              title={item.title}
              aria-label={`${item.title}, ${position + 1} of ${projects.length}`}
              aria-current={position === index ? "true" : undefined}
              onClick={() => selectProject(position)}
            />;
          })}
        </div>
        <button className="projects-carousel-arrow" type="button" aria-label="Next project" onClick={() => step(1)} disabled={index === projects.length - 1}><CaretRight size={13} weight="light" /></button>
      </div>
      <div aria-live="polite" aria-atomic="true" className="projects-carousel-title">
        <div key={project.id} style={{ "--carousel-title-size": titleSize }}>
          <h2>{project.title}</h2>
          <p>{tracks.length} {tracks.length === 1 ? "track" : "tracks"}</p>
        </div>
      </div>
      <div className="projects-carousel-actions">
        <button className="button button-primary projects-carousel-play" type="button" onClick={() => onPlay(project)} disabled={!tracks.length}><Play size={15} weight="fill" /><span>Play</span></button>
        <button className="button button-ghost" type="button" onClick={() => onOpen(project.id)}><FolderOpen size={16} />Open</button>
        <button
          ref={previewToggleRef}
          className="button button-ghost projects-preview-toggle"
          type="button"
          aria-expanded={previewOpen}
          aria-controls="projects-track-preview"
          onClick={() => previewOpen ? closePreview() : setPreviewProjectId(project.id)}
        ><ListBullets size={15} />Tracks</button>
      </div>
    </div>
  </div>;
}
