import React from "react";
import { MusicNote, Pause, Play, Plus } from "@phosphor-icons/react";

import { TrackPlaybackIndicator } from "./TrackPlaybackIndicator.jsx";

export function CarouselTrackPreview({ id, project, tracks, flipped, onPlayTrack, onAddTracks, playingTrackId, playbackState, progress }) {
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
    </div>
    {tracks.length ? <ol className="projects-preview-list">
      {tracks.map((track, trackIndex) => {
        const current = track.id === playingTrackId;
        const canPause = current && (playbackState === "playing" || playbackState === "transition");
        const canResume = current && (playbackState === "paused" || playbackState === "transition-paused");
        const loading = current && playbackState === "loading";
        const action = canPause ? "Pause" : canResume ? "Resume" : loading ? "Loading" : "Play";
        const Cue = canPause ? Pause : Play;
        return <li key={track.groupId ?? track.id} className={current ? "projects-preview-current" : undefined}>
          <button
            type="button"
            onClick={() => onPlayTrack(project, track)}
            aria-label={`${action} ${track.title}${track.versionName ? `, ${track.versionName}` : ""}`}
            aria-disabled={loading || undefined}
            aria-current={current ? "true" : undefined}
            style={current ? { "--track-progress": `${progress}%` } : undefined}
          >
            <span className="projects-preview-cue" aria-hidden="true">
              {canPause ? <span className="projects-preview-index"><TrackPlaybackIndicator /></span>
                : !current && <span className="projects-preview-index">{String(trackIndex + 1).padStart(2, "0")}</span>}
              <Cue className="projects-preview-cue-play" size={11} weight="fill" />
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
