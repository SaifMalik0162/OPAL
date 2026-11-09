import React, { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, ArrowUpRight, Check, NotePencil } from "@phosphor-icons/react";
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

export function Onboarding({ onClose, onEnter }) {
  const [showDemo, setShowDemo] = useState(false);
  const headingRef = useRef(null);
  const navigatedRef = useRef(false);

  useEffect(() => {
    if (navigatedRef.current) headingRef.current?.focus();
  }, [showDemo]);

  function changeScene(demo) {
    navigatedRef.current = true;
    setShowDemo(demo);
  }

  return (
    <div className="onboarding">
      <div className="onboarding-scene" key={Number(showDemo)}>
        <div className="onboarding-copy">
          <span className="onboarding-kicker">{showDemo ? "Try it out" : "OPAL · Early access"}</span>
          <h2 id="welcome-title" ref={headingRef} tabIndex={-1}>
            {showDemo ? <>Give every take <em>its place.</em></> : <>Welcome to <em>OPAL.</em></>}
          </h2>
          {showDemo ? (
            <p>Flip between versions, scrub the waveform, and mark a moment you’d come back to. The demo stays separate from your library.</p>
          ) : (
            <>
              <p>A listening room for the music you’re making and every version it could become.</p>
              <div className="onboarding-alpha"><span>Alpha</span><p>You’re early. Some things may change or break, and your feedback will help shape what comes next.</p></div>
            </>
          )}
        </div>
        <div className="onboarding-visual">
          {showDemo ? <VersionDemo /> : (
            <div className="onboarding-emblem" aria-hidden="true">
              <img src="/opal-mark.png" alt="" />
            </div>
          )}
        </div>
      </div>
      <footer className="onboarding-footer">
        {showDemo ? (
          <button type="button" className="button button-ghost" onClick={() => changeScene(false)}><ArrowLeft size={15} /> Back</button>
        ) : <span className="onboarding-credit">Made by <strong>packrunnersaif</strong></span>}
        <span className="onboarding-steps" role="img" aria-label={`Step ${showDemo ? 2 : 1} of 2`}>
          <i className={showDemo ? "" : "is-current"} /><i className={showDemo ? "is-current" : ""} />
        </span>
        <div className="onboarding-actions">
          {!showDemo && <button type="button" className="button button-ghost" onClick={onClose}>Skip</button>}
          <button type="button" className="button button-primary" onClick={showDemo ? onEnter : () => changeScene(true)}>
            {showDemo ? <>Enter Library <ArrowUpRight size={15} /></> : <>Take a quick look <ArrowRight size={15} /></>}
          </button>
        </div>
      </footer>
    </div>
  );
}
