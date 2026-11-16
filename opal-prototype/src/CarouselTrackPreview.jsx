import React from "react";
import { ArrowCounterClockwise, MusicNote, Play, Plus } from "@phosphor-icons/react";

import { TrackPlaybackIndicator } from "./TrackPlaybackIndicator.jsx";

export function CarouselTrackPreview({ id, project, tracks, flipped, closeRef, closePreview, onPlayTrack, onAddTracks, playingTrackId, isPlaying, progress }) {
  return <section
    id={id}
    className="projects-track-preview"
    aria-label={`Tracks in ${project.title}`}
    aria-hidden={!flipped}
    inert={!flipped}
  >
    <img className="projects-preview-art" src={project.artwork} alt="" draggable={false} />
    <div className="projects-preview-header">
      <div><strong>Tracks</strong><span>{tracks.length}</span></div>
      {closePreview && <button ref={closeRef} type="button" onClick={closePreview} aria-label="Return to cover"><ArrowCounterClockwise size={15} /></button>}
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
    </ol> : <div className="projects-preview-empty"><MusicNote size={23} weight="light" /><p>No tracks in this project yet.</p>
      {onAddTracks && <button className="button button-ghost" type="button" onClick={() => onAddTracks(project.id)}><Plus size={14} />Add tracks</button>}
    </div>}
  </section>;
}
