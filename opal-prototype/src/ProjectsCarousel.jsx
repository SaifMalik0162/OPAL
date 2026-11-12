import React, { useEffect, useRef, useState } from "react";
import { CaretDown, CaretLeft, CaretRight, FolderOpen, Play } from "@phosphor-icons/react";

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

export function ProjectsCarousel({ projects, index, onSelect, onOpen, onPlay, tracks, onPlayTrack }) {
  const stageRef = useRef(null);
  const coverRef = useRef(null);
  const previewRef = useRef(null);
  const gesture = useRef(null);
  const suppressClick = useRef(false);
  const wheel = useRef({ distance: 0, last: 0, lastStep: -Infinity, direction: 0 });
  const [drag, setDrag] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);
  const project = projects[index];

  function step(offset) {
    onSelect(clamp(index + offset, 0, projects.length - 1));
  }

  useEffect(() => {
    const stage = stageRef.current;
    function onWheel(event) {
      if (event.ctrlKey || event.metaKey) return;
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
      onSelect(clamp(index + direction, 0, projects.length - 1));
    }
    stage.addEventListener("wheel", onWheel, { passive: false });
    return () => stage.removeEventListener("wheel", onWheel);
  }, [index, onSelect, projects.length]);

  function revealTrackPreview() {
    const preview = previewRef.current;
    const player = document.querySelector(".player-shell");
    if (!preview || !player) return;
    const overlap = preview.getBoundingClientRect().bottom - player.getBoundingClientRect().top + 12;
    if (overlap > 0) window.scrollBy({ top: overlap, behavior: "instant" });
  }

  useEffect(() => {
    if (previewOpen && window.matchMedia("(prefers-reduced-motion: reduce)").matches) revealTrackPreview();
  }, [previewOpen]);

  function beginDrag(event) {
    if (!event.isPrimary || event.button !== 0 || projects.length < 2) return;
    suppressClick.current = false;
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
    if (event.altKey || event.metaKey || event.ctrlKey) return;
    if (event.key === "ArrowLeft") step(-1);
    else if (event.key === "ArrowRight") step(1);
    else if (event.key === "Home") onSelect(0);
    else if (event.key === "End") onSelect(projects.length - 1);
    else if (event.key === "Enter" && event.target === event.currentTarget) onOpen(project.id);
    else return;
    event.preventDefault();
    event.stopPropagation();
  }

  const first = Math.max(0, index - 3);
  const covers = projects.slice(first, index + 4);
  return <div className="projects-carousel">
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
      <div className="projects-carousel-light" key={project.artwork} aria-hidden="true">
        <img src={project.artwork} alt="" draggable={false} />
      </div>
      {covers.map((item, position) => {
        const itemIndex = first + position;
        const offset = itemIndex - index - drag;
        const depth = Math.abs(offset);
        const direction = Math.sign(offset);
        const spacing = Math.min(depth, 1) * 94 + Math.max(depth - 1, 0) * 60;
        const selected = itemIndex === index;
        return <button
          key={item.id}
          ref={selected ? coverRef : undefined}
          type="button"
          className="projects-carousel-cover"
          tabIndex={-1}
          aria-current={selected ? "true" : undefined}
          aria-hidden={Math.abs(itemIndex - index) > 2 ? "true" : undefined}
          aria-label={selected ? `Open ${item.title}` : `Select ${item.title}`}
          disabled={Math.abs(itemIndex - index) > 2}
          style={{
            "--cover-x": `${direction * spacing}%`,
            "--cover-turn": `${direction * Math.min(depth * 38, 64)}deg`,
            "--cover-scale": Math.max(0.48, 1 - Math.min(depth, 1) * 0.16 - Math.max(depth - 1, 0) * 0.22),
            "--cover-opacity": clamp(depth <= 1 ? 1 - depth * 0.06 : 0.94 - (depth - 1) * 0.47, 0, 1),
            zIndex: 20 - Math.round(depth * 4),
          }}
          onClick={() => {
            if (selected) onOpen(item.id);
            else onSelect(itemIndex);
            stageRef.current?.focus({ preventScroll: true });
          }}
        ><img src={item.artwork} alt="" draggable={false} /></button>;
      })}
    </div>
    <div className="projects-carousel-caption">
      <div className="projects-carousel-selection">
        <button className="projects-carousel-arrow" type="button" aria-label="Previous project" onClick={() => step(-1)} disabled={index === 0}><CaretLeft size={17} /></button>
        <div aria-live="polite" aria-atomic="true" className="projects-carousel-title">
          <div key={project.id}><h2>{project.title}</h2><p>{tracks.length} {tracks.length === 1 ? "track" : "tracks"}</p></div>
        </div>
        <button className="projects-carousel-arrow" type="button" aria-label="Next project" onClick={() => step(1)} disabled={index === projects.length - 1}><CaretRight size={17} /></button>
      </div>
      <div className="projects-carousel-actions">
        <button className="button button-primary" type="button" onClick={() => onPlay(project)} disabled={!tracks.length}><Play size={15} weight="fill" />Play</button>
        <button className="button button-ghost" type="button" onClick={() => onOpen(project.id)}><FolderOpen size={16} />Open</button>
        <button
          className="button button-ghost projects-preview-toggle"
          type="button"
          aria-expanded={previewOpen}
          aria-controls="projects-track-preview"
          onClick={() => setPreviewOpen((open) => !open)}
        >Tracks <CaretDown size={13} /></button>
      </div>
      <div
        id="projects-track-preview"
        ref={previewRef}
        className="projects-track-preview"
        data-open={previewOpen}
        inert={!previewOpen}
        onTransitionEnd={(event) => {
          if (previewOpen && event.target === event.currentTarget && event.propertyName === "grid-template-rows") revealTrackPreview();
        }}
      >
        <div className="projects-track-preview-clip">
          <div className="projects-track-preview-content" key={project.id}>
            {tracks.length ? <ol>
              {tracks.slice(0, 4).map((track) => <li key={track.id}>
                <button type="button" onClick={() => onPlayTrack(project, track)} aria-label={`Play ${track.title}, ${track.versionName}`}>
                  <Play size={13} weight="fill" />
                  <span className="projects-preview-track-title">{track.title}</span>
                  <span className="projects-preview-mix">{track.versionName}</span>
                  <span className="projects-preview-duration">{track.duration}</span>
                </button>
              </li>)}
            </ol> : <p>No tracks in this project yet.</p>}
            {tracks.length > 4 && <button type="button" className="text-action" onClick={() => onOpen(project.id)}>View all {tracks.length} tracks <CaretRight size={13} /></button>}
          </div>
        </div>
      </div>
    </div>
  </div>;
}
