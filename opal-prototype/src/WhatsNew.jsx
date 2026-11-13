import React from "react";
import { ArrowCounterClockwise, ArrowUpRight, ArrowsDownUp, Cards, ListBullets, MusicNote, NotePencil } from "@phosphor-icons/react";
import "./whats-new.css";

const waveform = [18, 31, 22, 43, 28, 60, 35, 74, 46, 82, 54, 67, 34, 72, 47, 91, 59, 39, 70, 44, 61, 27, 48, 21];

const highlights = [
  { Icon: Cards, tone: "ice", title: "Cinematic project carousel", detail: "Turn a cover over to reveal its tracklist." },
  { Icon: ListBullets, tone: "gold", title: "Drag tracks into place", detail: "Set a manual track order with a quick drag." },
  { Icon: ArrowsDownUp, tone: "pearl", title: "Sort your tracklist", detail: "Sort by title, date added, or last modified." },
  { Icon: NotePencil, tone: "mint", title: "A calmer project view", detail: "Versions, notes, and moments are easier to scan." },
];

function previewTracks(project) {
  const groups = new Map();
  for (const track of project?.tracks ?? []) {
    const key = track.groupId ?? track.id;
    const existing = groups.get(key);
    if (!existing || track.isCurrent) groups.set(key, track);
  }
  return [...groups.values()].sort((left, right) => (left.position ?? 0) - (right.position ?? 0));
}

export function WhatsNew({ projects, onClose }) {
  const availableProjects = projects.filter((project) => project.artwork);
  const featuredProject = availableProjects.find((project) => project.tracks?.length) ?? availableProjects[0] ?? null;
  const sideProjects = availableProjects.filter((project) => project.id !== featuredProject?.id).slice(0, 2);
  const sleeves = [sideProjects[0] ?? featuredProject, featuredProject, sideProjects[1] ?? featuredProject];
  const libraryTracks = previewTracks(featuredProject);

  return (
    <div className="whats-new">
      <section className="whats-new-layout">
        <div className="whats-new-art-panel" aria-hidden="true">
          <div className="whats-new-art-heading"><img src="/opal-mark.png" alt="" /><span>OPAL</span></div>
          <div className="whats-new-sleeves">
            {sleeves.map((project, index) => (
              <div className={`whats-new-sleeve whats-new-sleeve-${index}`} key={`${project?.id ?? "opal"}-${index}`}>
                {index === 1 ? (
                  <div className="projects-cover-turn whats-new-preview-turn">
                    <div className="projects-cover-front">
                      <img src={project?.artwork ?? "/artwork/opal-default-cover.png"} alt="" draggable={false} />
                    </div>
                    <div className="projects-track-preview whats-new-preview-back">
                      <img className="projects-preview-art" src={project?.artwork ?? "/artwork/opal-default-cover.png"} alt="" draggable={false} />
                      <div className="projects-preview-header">
                        <div><strong>Tracks</strong><span>{libraryTracks.length}</span></div>
                        <span className="whats-new-preview-return"><ArrowCounterClockwise size={15} /></span>
                      </div>
                      {libraryTracks.length ? <ol className="projects-preview-list">
                          {libraryTracks.slice(0, 4).map((track, trackIndex) => (
                            <li key={track.id}>
                              <button type="button" disabled>
                                <span className="projects-preview-cue">
                                  <span className="projects-preview-index">{String(trackIndex + 1).padStart(2, "0")}</span>
                                </span>
                                <span className="projects-preview-track-copy">
                                  <strong>{track.title}</strong>
                                  {track.versionName && <small>{track.versionName}</small>}
                                </span>
                                <span className="projects-preview-duration">{track.duration}</span>
                              </button>
                            </li>
                          ))}
                        </ol> : <div className="projects-preview-empty">
                          <MusicNote size={23} weight="light" />
                          <p>No tracks in this project yet.</p>
                        </div>}
                    </div>
                  </div>
                ) : (
                  <div className="projects-cover-front">
                    <img src={project?.artwork ?? "/artwork/opal-default-cover.png"} alt="" draggable={false} />
                  </div>
                )}
              </div>
            ))}
          </div>
          <div className="whats-new-art-footer">
            <div className="whats-new-waveform">{waveform.map((height, index) => <i key={index} style={{ "--bar-height": `${height}%` }} />)}<span aria-hidden="true" /></div>
          </div>
        </div>

        <div className="whats-new-copy">
          <header className="whats-new-header">
            <span className="whats-new-kicker">Alpha.5 <i>·</i> Release notes</span>
          </header>
          <h2 id="whats-new-title">Here’s what’s <em>new</em></h2>
          <ul className="whats-new-highlights">
            {highlights.map(({ Icon, tone, title, detail }) => (
              <li key={title}>
                <span className="whats-new-icon" data-tone={tone}><Icon size={18} weight="regular" /></span>
                <span><strong>{title}</strong><small>{detail}</small></span>
              </li>
            ))}
          </ul>
          <footer className="whats-new-footer">
            <button type="button" className="button button-primary" onClick={onClose}><span>Explore Alpha 5</span><ArrowUpRight size={15} /></button>
          </footer>
        </div>
      </section>
    </div>
  );
}
