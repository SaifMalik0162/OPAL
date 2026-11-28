import React, { useEffect, useRef, useState } from "react";
import {
  ArrowCounterClockwise,
  ArrowDown,
  CaretDown,
  CaretRight,
  Check,
  DotsThree,
  GearSix,
  Headphones,
  ListBullets,
  MagnifyingGlass,
  MusicNote,
  NotePencil,
  Pause,
  Play,
  Plus,
  Queue,
  Repeat,
  Shuffle,
  SkipBack,
  SkipForward,
  SpeakerHigh,
  X,
} from "@phosphor-icons/react";

const ART = "/artwork/night-bloom.png";
const TRACKS = [
  { title: "First Light", version: "Original", duration: "3:48" },
  { title: "Blue Window", version: "Mix 02", duration: "2:56" },
  { title: "Night Bloom", version: "Original", duration: "2:41" },
];
const NOTE_SEEDS = {
  project: "Let the opening breathe before the first lift.\n\nKeep the warm, open tone through the final pass.",
  first: "The first phrase lands well. Leave a little more air before the second entrance.",
  blue: "Low end feels settled here. Keep the quieter transition into the last section.",
};
const WAVEFORM = Array.from({ length: 96 }, (_, index) => {
  const broad = Math.abs(Math.sin(index * 0.31) * Math.cos(index * 0.083));
  const detail = Math.abs(Math.sin(index * 1.47) * 0.28);
  return Math.max(12, Math.round(12 + broad * 36 + detail * 10));
});

function setLocationState(key, value) {
  const url = new URL(window.location.href);
  if (value === null) url.searchParams.delete(key);
  else url.searchParams.set(key, value);
  window.history.replaceState({}, "", url);
}

function SafeArtwork({ className, alt = "", src = ART }) {
  const [image, setImage] = useState(src);
  useEffect(() => setImage(src), [src]);
  return <img
    className={className}
    src={image}
    alt={alt}
    draggable="false"
    onError={() => setImage("/opal-mark.png")}
  />;
}

function AppHeader({ title }) {
  return <header className="pass-a-header">
    <div className="pass-a-brand">
      <SafeArtwork className="pass-a-brand-mark" src="/opal-mark.png" alt="" />
      <span>OPAL</span>
    </div>
    <label className="pass-a-search">
      <MagnifyingGlass size={16} aria-hidden="true" />
      <input aria-label="Search projects" placeholder="Search" disabled />
    </label>
    <div className="pass-a-view-switch" role="group" aria-label="Library view">
      <span aria-current="page">Carousel</span>
      <span>Grid</span>
    </div>
    <div className="pass-a-header-tools" aria-hidden="true">
      <span className="pass-a-sort">Recently updated <CaretDown size={12} /></span>
      <span className="pass-a-header-icon"><Plus size={16} /></span>
      <span className="pass-a-header-icon"><GearSix size={16} /></span>
    </div>
    <span className="pass-a-sr-only">{title}</span>
  </header>;
}

function FloatingPlayer({ title }) {
  return <div className="pass-a-floating-player" aria-hidden="true">
    <div className="pass-a-player-transport"><SkipBack size={17} weight="fill" /><Play size={18} weight="fill" /><SkipForward size={17} weight="fill" /></div>
    <div className="pass-a-player-track">
      <SafeArtwork className="pass-a-player-art" />
      <div className="pass-a-player-copy"><strong>First Light</strong><small>Original · {title}</small></div>
      <div className="pass-a-player-wave"><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /></div>
      <DotsThree size={18} />
    </div>
    <div className="pass-a-player-utilities"><Shuffle size={16} /><Repeat size={16} /><ListBullets size={17} /><SpeakerHigh size={17} /></div>
  </div>;
}

function SideSleeves() {
  return <div className="pass-a-side-sleeves" aria-hidden="true">
    <div className="pass-a-side-card pass-a-side-far-left"><SafeArtwork src="/artwork/veil-atlas.png" /></div>
    <div className="pass-a-side-card pass-a-side-near-left"><SafeArtwork src="/artwork/slow-light.png" /></div>
    <div className="pass-a-side-card pass-a-side-near-right"><SafeArtwork src="/artwork/slow-light.png" /></div>
    <div className="pass-a-side-card pass-a-side-far-right"><SafeArtwork src="/artwork/veil-atlas.png" /></div>
  </div>;
}

function ActionButton({ action, active, expanded, onClick, buttonRef }) {
  const Icon = action === "Notes" ? NotePencil : action === "Tracks" ? ListBullets : Headphones;
  const description = action === "Listen" ? "Open Listen" : "Open " + action.toLowerCase();
  return <button
    ref={buttonRef}
    className={"pass-a-action" + (active ? " is-active" : "")}
    type="button"
    aria-label={description}
    aria-expanded={expanded}
    aria-controls={action === "Listen" ? "pass-a-listen" : "pass-a-sleeve-reverse"}
    onClick={onClick}
  >
    <Icon size={14} aria-hidden="true" />
    <span>{action}</span>
  </button>;
}

function NotesReverse({ projectTitle, context, setContext, text, setText, dirty, onReturn, editorRef }) {
  const contextLabel = context === "project" ? "Project" : context === "first" ? "First Light · Original" : "Blue Window · Mix 02";
  return <section className="pass-a-reverse pass-a-notes-reverse" role="region" aria-label="Project notes">
    <SafeArtwork className="pass-a-reverse-art" />
    <div className="pass-a-reverse-wash" />
    <header className="pass-a-reverse-header">
      <div className="pass-a-reverse-title">
        <NotePencil size={16} aria-hidden="true" />
        <div><strong>Notes</strong><small>{projectTitle}</small></div>
      </div>
      <button className="pass-a-cover-button" type="button" onClick={onReturn} aria-label="Return to cover">
        <ArrowCounterClockwise size={14} aria-hidden="true" /><span>Cover</span>
      </button>
    </header>
    <div className="pass-a-note-body">
      <label className="pass-a-context">
        <span>Scope</span>
        <span className="pass-a-select-wrap">
          <select aria-label="Note context" value={context} onChange={(event) => setContext(event.target.value)}>
            <option value="project">Project</option>
            <option value="first">First Light · Original</option>
            <option value="blue">Blue Window · Mix 02</option>
          </select>
          <CaretDown size={13} aria-hidden="true" />
        </span>
      </label>
      <textarea
        ref={editorRef}
        aria-label={contextLabel + " notes"}
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder="Write a note for this project…"
        spellCheck="true"
      />
      {context !== "project" && <section className="pass-a-moments" aria-label="Existing moments">
        <div className="pass-a-moments-heading"><span>Moments</span><span>2</span></div>
        <ol>
          <li><time>0:42</time><span>Leave space before the lift</span></li>
          <li><time>1:36</time><span>Warmth settles into the verse</span></li>
        </ol>
      </section>}
    </div>
    <footer className="pass-a-note-footer">
      <span className="pass-a-saved"><Check size={13} aria-hidden="true" />{dirty ? "Draft · preview only" : "Saved · sample"}</span>
      <span className="pass-a-sample-tag">Sample project</span>
    </footer>
  </section>;
}

function TracksReverse({ projectTitle, currentTrack, currentTrackIndex, setCurrentTrackIndex, onReturn }) {
  return <section className="pass-a-reverse pass-a-tracks-reverse" role="region" aria-label={"Tracks in " + projectTitle}>
    <SafeArtwork className="pass-a-reverse-art" />
    <div className="pass-a-reverse-wash" />
    <header className="pass-a-reverse-header">
      <div className="pass-a-reverse-title">
        <ListBullets size={16} aria-hidden="true" />
        <div><strong>Tracks</strong><small>{TRACKS.length} tracks · 9 min</small></div>
      </div>
      <button className="pass-a-cover-button" type="button" onClick={onReturn} aria-label="Return to cover">
        <ArrowCounterClockwise size={14} aria-hidden="true" /><span>Cover</span>
      </button>
    </header>
    <ol className="pass-a-track-list">
      {TRACKS.map((track, index) => <li key={track.title}>
        <button type="button" className={index === currentTrackIndex ? "is-current" : ""} onClick={() => setCurrentTrackIndex(index)}>
          <span className="pass-a-track-index">{index === currentTrackIndex ? <Play size={11} weight="fill" /> : String(index + 1).padStart(2, "0")}</span>
          <span className="pass-a-track-copy"><strong>{track.title}</strong><small>{track.version}</small></span>
          <time>{track.duration}</time>
        </button>
      </li>)}
    </ol>
    <footer className="pass-a-note-footer"><span className="pass-a-saved"><MusicNote size={13} aria-hidden="true" />{currentTrack.title} · sample</span></footer>
  </section>;
}

function Waveform() {
  return <div className="pass-a-waveform" role="img" aria-label="Illustrative sample waveform, not audio analysis">
    <time>0:42</time>
    <div className="pass-a-wave-bars" aria-hidden="true">
      {WAVEFORM.map((height, index) => <i key={index} className={index < 25 ? "is-past" : ""} style={{ height: height + "%" }} />)}
    </div>
    <time>3:48</time>
  </div>;
}

function ListenScreen({ title, currentTrackIndex, setCurrentTrackIndex, onCollapse, collapseRef, longTitle }) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [shuffle, setShuffle] = useState(false);
  const [repeat, setRepeat] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [volumeOpen, setVolumeOpen] = useState(false);
  const [volume, setVolume] = useState(72);
  const [momentOpen, setMomentOpen] = useState(false);
  const [momentNote, setMomentNote] = useState("");
  const [momentSaved, setMomentSaved] = useState(false);
  const queueButtonRef = useRef(null);
  const volumeButtonRef = useRef(null);
  const momentButtonRef = useRef(null);
  const currentTrack = longTitle && currentTrackIndex === 0
    ? { ...TRACKS[0], title: "A Quiet, Weightless Passage Through the Last Light" }
    : TRACKS[currentTrackIndex];

  function shiftTrack(direction) {
    setCurrentTrackIndex((currentTrackIndex + direction + TRACKS.length) % TRACKS.length);
  }

  function closeMoment() {
    setMomentOpen(false);
    window.requestAnimationFrame(() => momentButtonRef.current?.focus({ preventScroll: true }));
  }

  return <section className="pass-a-listen" id="pass-a-listen" aria-label="Listen visual preview" onKeyDown={(event) => {
    if (event.key !== "Escape") return;
    if (momentOpen) {
      event.stopPropagation();
      event.preventDefault();
      closeMoment();
    } else if (queueOpen) {
      event.stopPropagation();
      event.preventDefault();
      setQueueOpen(false);
      window.requestAnimationFrame(() => queueButtonRef.current?.focus({ preventScroll: true }));
    } else if (volumeOpen) {
      event.stopPropagation();
      event.preventDefault();
      setVolumeOpen(false);
      window.requestAnimationFrame(() => volumeButtonRef.current?.focus({ preventScroll: true }));
    }
  }}>
    <SafeArtwork className="pass-a-listen-atmosphere" />
    <div className="pass-a-listen-veil" />
    <header className="pass-a-listen-header">
      <div className="pass-a-listen-context"><SafeArtwork src="/opal-mark.png" /><span>{title}<small>Project</small></span></div>
      <button ref={collapseRef} className="pass-a-collapse" type="button" onClick={onCollapse} aria-label="Collapse Listen">
        <ArrowDown size={14} aria-hidden="true" /><span>Collapse</span>
      </button>
    </header>
    <main className="pass-a-listen-main">
      <div className="pass-a-listen-cover"><SafeArtwork alt={title + " artwork"} /></div>
      <div className="pass-a-listen-track-copy">
        <h1>{currentTrack.title}</h1>
        <p>{currentTrack.version} · {title}</p>
      </div>
    </main>
    <footer className="pass-a-listen-controls">
      <Waveform />
      <div className="pass-a-transport-wrap">
        <div className="pass-a-transport-side pass-a-transport-left">
          <button type="button" className={shuffle ? "is-on" : ""} onClick={() => setShuffle(!shuffle)} title="Shuffle" aria-label={shuffle ? "Turn shuffle off" : "Turn shuffle on"} aria-pressed={shuffle}><Shuffle size={19} /></button>
          <button type="button" className={repeat ? "is-on" : ""} onClick={() => setRepeat(!repeat)} title="Repeat" aria-label={repeat ? "Turn repeat off" : "Turn repeat on"} aria-pressed={repeat}><Repeat size={19} /></button>
        </div>
        <div className="pass-a-primary-transport">
          <button type="button" onClick={() => shiftTrack(-1)} title="Previous track" aria-label="Previous track"><SkipBack size={20} weight="fill" /></button>
          <button type="button" className="pass-a-play" onClick={() => setIsPlaying(!isPlaying)} title={isPlaying ? "Pause" : "Play"} aria-label={isPlaying ? "Pause sample preview" : "Play sample preview"}>{isPlaying ? <Pause size={22} weight="fill" /> : <Play size={22} weight="fill" />}</button>
          <button type="button" onClick={() => shiftTrack(1)} title="Next track" aria-label="Next track"><SkipForward size={20} weight="fill" /></button>
        </div>
        <div className="pass-a-transport-side pass-a-transport-right">
          <div className="pass-a-popover-anchor">
            <button ref={queueButtonRef} type="button" className={queueOpen ? "is-on" : ""} onClick={() => { setQueueOpen(!queueOpen); setVolumeOpen(false); }} title="Queue" aria-label="Toggle queue" aria-expanded={queueOpen}><Queue size={19} /></button>
          </div>
          <div className="pass-a-popover-anchor">
            <button ref={volumeButtonRef} type="button" className={volumeOpen ? "is-on" : ""} onClick={() => { setVolumeOpen(!volumeOpen); setQueueOpen(false); }} title="Volume" aria-label="Adjust sample volume" aria-expanded={volumeOpen}><SpeakerHigh size={19} /></button>
          </div>
          <button ref={momentButtonRef} type="button" onClick={() => { setMomentSaved(false); setMomentOpen(true); }} title="Add moment" aria-label="Add a moment"><Plus size={19} /></button>
        </div>
      </div>
    </footer>
    {queueOpen && <div className="pass-a-popover pass-a-queue-popover" role="region" aria-label="Playback queue">
      <strong>Up next</strong>
      {TRACKS.map((track, index) => <button key={track.title} type="button" onClick={() => { setCurrentTrackIndex(index); setQueueOpen(false); window.requestAnimationFrame(() => queueButtonRef.current?.focus({ preventScroll: true })); }}><span>{track.title}</span><time>{track.duration}</time></button>)}
    </div>}
    {volumeOpen && <div className="pass-a-popover pass-a-volume-popover" role="group" aria-label="Sample volume"><label>Volume <span>{volume}%</span><input type="range" min="0" max="100" value={volume} onChange={(event) => setVolume(Number(event.target.value))} /></label></div>}
    {momentOpen && <div className="pass-a-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeMoment(); }}>
      <section className="pass-a-moment-dialog" role="dialog" aria-modal="true" aria-labelledby="pass-a-moment-title">
        <header><div><span className="pass-a-moment-icon"><NotePencil size={16} /></span><div><h2 id="pass-a-moment-title">Add a moment</h2><p>{currentTrack.title} <span>·</span> 0:42</p></div></div><button type="button" onClick={closeMoment} aria-label="Close moment composer"><X size={17} /></button></header>
        <textarea autoFocus value={momentNote} onChange={(event) => setMomentNote(event.target.value)} placeholder="What do you want to remember?" aria-label="Moment note" />
        <footer><span>{momentSaved ? "Sample moment created" : "Preview only · nothing saved"}</span><button type="button" onClick={() => { setMomentSaved(true); closeMoment(); }}>{momentSaved ? "Done" : "Add moment"}</button></footer>
      </section>
    </div>}
  </section>;
}

export function PassAPreview() {
  const params = new URLSearchParams(window.location.search);
  const requestedSurface = params.get("surface");
  const initialSurface = ["notes", "tracks", "listen"].includes(requestedSurface) ? requestedSurface : "carousel";
  const [surface, setSurface] = useState(initialSurface);
  const theme = params.get("theme") === "light" ? "light" : "dark";
  const [currentTrackIndex, setCurrentTrackIndex] = useState(0);
  const [context, setContext] = useState(params.get("context") === "track" ? "first" : "project");
  const [noteDrafts, setNoteDrafts] = useState(NOTE_SEEDS);
  const [dirty, setDirty] = useState(false);
  const [compactActions] = useState(params.get("compactActions") === "1");
  const longTitle = params.get("long") === "1";
  const missingArtwork = params.get("missingArtwork") === "1";
  const projectTitle = longTitle ? "Where the Last Light Settles Over an Open Sea" : "Night Bloom";
  const artwork = missingArtwork ? "/artwork/pass-a-missing-artwork.png" : ART;
  const noteEditorRef = useRef(null);
  const notesButtonRef = useRef(null);
  const tracksButtonRef = useRef(null);
  const listenButtonRef = useRef(null);
  const collapseButtonRef = useRef(null);
  const returnActionRef = useRef("notes");
  const focusNextRef = useRef(false);
  const title = projectTitle;
  const currentTrack = TRACKS[currentTrackIndex];
  const noteKey = context;

  useEffect(() => {
    document.title = "OPAL · Pass A Visual Preview";
  }, []);

  useEffect(() => {
    if (!focusNextRef.current) return undefined;
    focusNextRef.current = false;
    const target = surface === "notes" ? noteEditorRef.current : surface === "listen" ? collapseButtonRef.current : null;
    if (!target) return undefined;
    const frame = window.requestAnimationFrame(() => target.focus({ preventScroll: true }));
    return () => window.cancelAnimationFrame(frame);
  }, [surface]);

  useEffect(() => {
    function onKeyDown(event) {
      if (event.key !== "Escape") return;
      if (surface === "notes" || surface === "tracks") {
        event.preventDefault();
        closeSleeve();
      } else if (surface === "listen") {
        event.preventDefault();
        collapseListen();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [surface]);

  function openSurface(next) {
    returnActionRef.current = next;
    focusNextRef.current = true;
    setSurface(next);
    setLocationState("surface", next);
  }

  function closeSleeve() {
    const action = returnActionRef.current;
    setSurface("carousel");
    setLocationState("surface", "carousel");
    window.requestAnimationFrame(() => {
      const opener = action === "tracks" ? tracksButtonRef.current : notesButtonRef.current;
      opener?.focus({ preventScroll: true });
    });
  }

  function collapseListen() {
    setSurface("carousel");
    setLocationState("surface", "carousel");
    window.requestAnimationFrame(() => listenButtonRef.current?.focus({ preventScroll: true }));
  }

  function changeContext(next) {
    setContext(next);
    setDirty(false);
    setLocationState("context", next === "project" ? null : "track");
  }

  function changeNote(value) {
    setNoteDrafts((previous) => ({ ...previous, [noteKey]: value }));
    setDirty(true);
  }

  return <div className="pass-a-app" data-theme={theme} data-surface={surface} data-compact-actions={compactActions || undefined}>
    {surface !== "listen" && <AppHeader title={title} />}
    {surface === "listen" ? <ListenScreen title={title} currentTrackIndex={currentTrackIndex} setCurrentTrackIndex={setCurrentTrackIndex} onCollapse={collapseListen} collapseRef={collapseButtonRef} longTitle={longTitle} /> : <>
      <main className="pass-a-carousel" aria-label="Project carousel preview">
        <div className="pass-a-carousel-stage">
          <SideSleeves />
          <div className="pass-a-selected-wrap">
            <div className="pass-a-sleeve" data-flipped={surface === "notes" || surface === "tracks"}>
              <div className="pass-a-sleeve-turn">
                <article className="pass-a-sleeve-face pass-a-sleeve-front" aria-hidden={surface === "notes" || surface === "tracks"} inert={surface === "notes" || surface === "tracks"}>
                  <div className="pass-a-cover-frame"><SafeArtwork src={artwork} alt={title + " cover"} /></div>
                  <div className="pass-a-front-meta">
                    <h1 title={title}>{title}</h1>
                    <p>ALVA · Independent</p>
                    <div className="pass-a-actions" role="group" aria-label={title + " actions"}>
                      <ActionButton action="Notes" active={false} expanded={surface === "notes"} buttonRef={notesButtonRef} onClick={() => openSurface("notes")} />
                      <ActionButton action="Tracks" active={false} expanded={surface === "tracks"} buttonRef={tracksButtonRef} onClick={() => openSurface("tracks")} />
                      <ActionButton action="Listen" active={false} expanded={surface === "listen"} buttonRef={listenButtonRef} onClick={() => openSurface("listen")} />
                    </div>
                  </div>
                </article>
                <article id="pass-a-sleeve-reverse" className="pass-a-sleeve-face pass-a-sleeve-back" aria-hidden={surface !== "notes" && surface !== "tracks"} inert={surface !== "notes" && surface !== "tracks"}>
                  {surface === "notes" ? <NotesReverse
                    projectTitle={title}
                    context={context}
                    setContext={changeContext}
                    text={noteDrafts[noteKey]}
                    setText={changeNote}
                    dirty={dirty}
                    onReturn={closeSleeve}
                    editorRef={noteEditorRef}
                  /> : <TracksReverse
                    projectTitle={title}
                    currentTrack={currentTrack}
                    currentTrackIndex={currentTrackIndex}
                    setCurrentTrackIndex={setCurrentTrackIndex}
                    onReturn={closeSleeve}
                  />}
                </article>
              </div>
            </div>
            <p className="pass-a-carousel-caption"><span>3 tracks · 9 min</span><CaretRight size={14} aria-hidden="true" /></p>
          </div>
        </div>
      </main>
      <FloatingPlayer title={title} />
    </>}
  </div>;
}
