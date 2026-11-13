import React, { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, FolderOpen, ListBullets, NotePencil, Plus } from "@phosphor-icons/react";
import "./onboarding.css";

const demoVersions = [
  { name: "Original", bars: [16, 23, 15, 44, 33, 58, 22, 41, 72, 49, 81, 55, 35, 68, 41, 90, 73, 40, 58, 29, 79, 54, 69, 36, 57, 42, 31, 53, 35, 28, 17, 11] },
  { name: "Alt mix", bars: [25, 17, 35, 28, 47, 39, 64, 47, 85, 67, 75, 30, 63, 42, 76, 58, 87, 63, 41, 78, 62, 38, 73, 55, 64, 29, 58, 31, 42, 23, 30, 14] },
];

function VersionDemo() {
  const [versionIndex, setVersionIndex] = useState(0);
  const [position, setPosition] = useState(32);
  const [moment, setMoment] = useState(null);
  const { bars } = demoVersions[versionIndex];
  const seconds = Math.round(position * 1.2);
  const time = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;

  return (
    <div className="onboarding-demo">
      <div className="onboarding-demo-heading">
        <img src="/artwork/opal-default-cover.png" alt="" />
        <div><span>Interactive demo</span><strong>Midnight Sketch</strong></div>
      </div>
      <div className="onboarding-versions" role="group" aria-label="Demo track versions">
        {demoVersions.map(({ name }, index) => (
          <button key={name} type="button" aria-pressed={versionIndex === index} onClick={() => setVersionIndex(index)}>{name}</button>
        ))}
      </div>
      <div className="onboarding-demo-wave">
        <div className="onboarding-demo-bars" aria-hidden="true">
          {bars.map((height, index) => (
            <span key={index} className={index / bars.length * 100 < position ? "is-played" : ""} style={{ height: `${height}%` }} />
          ))}
        </div>
        {moment !== null && <span className="onboarding-moment-marker" aria-hidden="true" style={{ left: `clamp(3px, ${moment}%, calc(100% - 3px))` }} />}
        <input type="range" min="0" max="100" value={position} aria-label="Demo playback position" aria-valuetext={time} onChange={(event) => setPosition(Number(event.target.value))} />
      </div>
      <div className="onboarding-demo-footer">
        <span>{time} / 2:00</span>
        <button type="button" onClick={() => setMoment(position)}>
          {moment === position ? <Check size={14} /> : <NotePencil size={14} />}
          <span role="status">{moment === position ? "Moment marked" : "Mark a moment"}</span>
        </button>
      </div>
    </div>
  );
}

const firstProjectSteps = [
  { Icon: FolderOpen, title: "New project", detail: "Give a song or collection a home." },
  { Icon: ListBullets, title: "Add tracks", detail: "Import the audio you want to listen back to." },
  { Icon: Plus, title: "Add bounce", detail: "Use a track’s ··· menu to add another version of that track." },
];

const welcomePages = [
  {
    kicker: "Early access",
    title: <>Welcome to <em>OPAL.</em></>,
    description: "A local music library for work in progress. Keep demos, mixes, and alternate takes together so you can pick up where you left off.",
    action: "Take a quick look",
  },
  {
    kicker: "Try it out",
    title: <>Listen back with <em>context.</em></>,
    description: "Switch versions, scrub the waveform, and mark a Moment to find that spot again. Use Notes & Moments in a project to revisit your notes and saved timestamps.",
    action: "Next",
  },
  {
    kicker: "Getting started",
    title: <>Start with <em>a project.</em></>,
    description: "Bring in a rough bounce, a finished mix, or a whole tracklist. OPAL keeps its own local copies, so your original files stay where they are.",
    action: "Next",
  },
  {
    title: <>Thanks for trying <em>OPAL.</em></>,
    description: "It means a lot that you’re giving OPAL a try this early. I hope it makes it a little easier to come back to the music you’re working on.",
  },
];

export function Onboarding({ onClose, onEnter }) {
  const [pageIndex, setPageIndex] = useState(0);
  const headingRef = useRef(null);
  const navigatedRef = useRef(false);
  const page = welcomePages[pageIndex];
  const isFirstPage = pageIndex === 0;
  const isLastPage = pageIndex === welcomePages.length - 1;

  useEffect(() => {
    if (navigatedRef.current) headingRef.current?.focus();
  }, [pageIndex]);

  function changePage(index) {
    navigatedRef.current = true;
    setPageIndex(index);
  }

  return (
    <div className="onboarding">
      <div className={isLastPage ? "onboarding-scene onboarding-thank-you" : "onboarding-scene"} key={pageIndex}>
        <div className="onboarding-copy">
          {page.kicker && <span className="onboarding-kicker">{page.kicker}</span>}
          <h2 id="welcome-title" ref={headingRef} tabIndex={-1}>{page.title}</h2>
          <p>{page.description}</p>
          {isFirstPage && <div className="onboarding-alpha"><span>Alpha</span><p>OPAL is still in development. Your feedback helps shape what comes next.</p></div>}
          {pageIndex === 1 && <p className="onboarding-demo-note">This demo doesn’t change your library.</p>}
          {isLastPage && <p className="onboarding-signature">— <strong>packrunnersaif</strong></p>}
        </div>
        <div className="onboarding-visual">
          {(isFirstPage || isLastPage) && <div className="onboarding-emblem" aria-hidden="true"><img src="/opal-mark.png" alt="" /></div>}
          {pageIndex === 1 && <VersionDemo />}
          {pageIndex === 2 && (
            <ol className="onboarding-demo onboarding-project-steps" aria-label="How to start a project">
              {firstProjectSteps.map(({ Icon, title, detail }) => (
                <li key={title}>
                  <span className="onboarding-project-icon" aria-hidden="true"><Icon size={18} /></span>
                  <div><strong>{title}</strong><p>{detail}</p></div>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
      <footer className="onboarding-footer">
        {isFirstPage ? (
          <span className="onboarding-credit">Made by <strong>packrunnersaif</strong></span>
        ) : (
          <button type="button" className="button button-ghost" onClick={() => changePage(pageIndex - 1)}><ArrowLeft size={15} /> Back</button>
        )}
        <span className="onboarding-steps" role="img" aria-label={`Step ${pageIndex + 1} of ${welcomePages.length}`}>
          {welcomePages.map((_, index) => <i key={index} className={index === pageIndex ? "is-current" : ""} />)}
        </span>
        <div className="onboarding-actions">
          {isFirstPage && <button type="button" className="button button-ghost" onClick={onClose}>Skip</button>}
          <button type="button" className="button button-primary" onClick={isLastPage ? onEnter : () => changePage(pageIndex + 1)}>
            {isLastPage ? <>Enter Library <ArrowUpRight size={15} /></> : <>{page.action} <ArrowRight size={15} /></>}
          </button>
        </div>
      </footer>
    </div>
  );
}
