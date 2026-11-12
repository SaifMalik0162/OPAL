import React from "react";
import { ArrowUpRight, ArrowsDownUp, Cards, ListBullets, NotePencil } from "@phosphor-icons/react";
import "./whats-new.css";

const waveform = [18, 31, 22, 43, 28, 60, 35, 74, 46, 82, 54, 67, 34, 72, 47, 91, 59, 39, 70, 44, 61, 27, 48, 21];

const highlights = [
  { Icon: Cards, tone: "ice", title: "Cinematic project carousel", detail: "Browse with full-size covers and fluid motion." },
  { Icon: ListBullets, tone: "gold", title: "Drag tracks into place", detail: "Set a manual track order with a quick drag." },
  { Icon: ArrowsDownUp, tone: "pearl", title: "Sort your tracklist", detail: "Sort by title, date added, or last modified." },
  { Icon: NotePencil, tone: "mint", title: "A calmer project view", detail: "Versions, notes, and moments are easier to scan." },
];

export function WhatsNew({ projects, onClose }) {
  const availableProjects = projects.filter((project) => project.artwork).slice(0, 3);
  const sleeves = Array.from({ length: 3 }, (_, index) => availableProjects[index] ?? availableProjects[0] ?? null);

  return (
    <div className="whats-new">
      <section className="whats-new-layout">
        <div className="whats-new-art-panel" aria-hidden="true">
          <div className="whats-new-art-heading"><img src="/opal-mark.png" alt="" /><span>OPAL</span></div>
          <div className="whats-new-sleeves">
            {sleeves.map((project, index) => (
              <div className={`whats-new-sleeve whats-new-sleeve-${index}`} key={`${project?.id ?? "opal"}-${index}`}>
                <img src={project?.artwork ?? "/artwork/opal-default-cover.png"} alt="" />
                <div><strong>{project?.title ?? "A new collection"}</strong><span>{project ? `${project.tracks?.length ?? 0} tracks` : "Made for what’s next"}</span></div>
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
