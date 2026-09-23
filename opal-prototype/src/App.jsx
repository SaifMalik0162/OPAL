import React, { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open } from "@tauri-apps/plugin-dialog";
import { isCurrentPlaybackRequest, previousQueueIndex, repeatQueueIndex, shuffleQueue } from "./playback-queue.js";
import { reconcilePlayingQueue } from "./queue-state.js";
import { shouldApplyNoteSave } from "./note-revisions.js";
import { createNoteStore, noteKeyParts } from "./note-store.js";
import { createWaveform, waveformSeed } from "./waveform.js";
import { cacheWaveform, readCachedWaveform } from "./waveform-cache.js";
import {
  ArrowLeft,
  ArrowSquareOut,
  ArrowUpRight,
  CaretDown,
  CaretLeft,
  CaretRight,
  Check,
  CircleNotch,
  CloudCheck,
  Database,
  DotsThree,
  Export,
  FileAudio,
  FolderOpen,
  Gear,
  Info,
  ImageSquare,
  ListBullets,
  MagnifyingGlass,
  NotePencil,
  Pause,
  Play,
  Plus,
  Queue,
  Repeat,
  RepeatOnce,
  Shuffle,
  SlidersHorizontal,
  SkipBack,
  SkipForward,
  SpeakerHigh,
  SpeakerX,
  TextAa,
  Trash,
  WarningCircle,
  Waveform,
  X,
} from "@phosphor-icons/react";

const FALLBACK_ARTWORK = "/artwork/veil-atlas.png";
const AUDIO_FILTERS = [{ name: "Audio", extensions: ["wav", "mp3", "flac", "aiff", "aif", "m4a"] }];
const ARTWORK_FILTERS = [{ name: "Artwork", extensions: ["png", "jpg", "jpeg", "webp"] }];
const PLAYBACK_STORAGE_KEY = "opal-playback-v1";
const SORT_STORAGE_KEY = "opal-sort-v1";
const PREFERENCES_STORAGE_KEY = "opal-preferences-v1";
const APP_VERSION = "0.1.0-alpha.1";

function readPreferences() {
  try {
    return { largeType: false, reduceMotion: false, softerGlass: false, ...JSON.parse(window.localStorage.getItem(PREFERENCES_STORAGE_KEY) ?? "{}") };
  } catch {
    return { largeType: false, reduceMotion: false, softerGlass: false };
  }
}

function isRecoveryError(value) {
  return String(value).startsWith("RECOVERY_REQUIRED:");
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function hydrateProject(project) {
  return {
    ...project,
    artwork: isTauri() && project.artworkPath ? convertFileSrc(project.artworkPath) : FALLBACK_ARTWORK,
    type: project.typeLabel,
    year: String(project.year),
    tracks: project.tracks ?? [],
  };
}

function readPlaybackSnapshot() {
  try {
    return JSON.parse(window.localStorage.getItem(PLAYBACK_STORAGE_KEY) ?? "null") ?? {};
  } catch {
    return {};
  }
}

function readSortPreference() {
  try {
    return window.localStorage.getItem(SORT_STORAGE_KEY) ?? "updated";
  } catch {
    return "updated";
  }
}

function formatTime(durationMs) {
  if (!durationMs || durationMs < 0) return "0:00";
  const seconds = Math.floor(durationMs / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function App() {
  const savedPlayback = useMemo(readPlaybackSnapshot, []);
  const [activeView, setActiveView] = useState("library");
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [selectedId, setSelectedId] = useState("");
  const [focusedTrackId, setFocusedTrackId] = useState("");
  const [playingProjectId, setPlayingProjectId] = useState(savedPlayback.projectId ?? "");
  const [playingTrackId, setPlayingTrackId] = useState(savedPlayback.trackId ?? "");
  const [playbackState, setPlaybackState] = useState("idle");
  const [playbackError, setPlaybackError] = useState("");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [durationMs, setDurationMs] = useState(0);
  const [volume, setVolume] = useState(Number.isFinite(savedPlayback.volume) ? savedPlayback.volume : 72);
  const [muted, setMuted] = useState(Boolean(savedPlayback.muted));
  const [volumeOpen, setVolumeOpen] = useState(false);
  const [queueOpen, setQueueOpen] = useState(false);
  const [playerMenuOpen, setPlayerMenuOpen] = useState(false);
  const [shuffleEnabled, setShuffleEnabled] = useState(false);
  const [repeatMode, setRepeatMode] = useState("off");
  const [profileOpen, setProfileOpen] = useState(false);
  const [storageInfo, setStorageInfo] = useState(null);
  const [storageError, setStorageError] = useState("");
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [diagnostics, setDiagnostics] = useState(null);
  const [trackInfo, setTrackInfo] = useState(null);
  const [confirmState, setConfirmState] = useState(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [preferences, setPreferences] = useState(readPreferences);
  const [query, setQuery] = useState("");
  const [sortMode, setSortMode] = useState(readSortPreference);
  const [notesOpen, setNotesOpen] = useState(true);
  const [noteTargetId, setNoteTargetId] = useState(null);
  const [noteText, setNoteText] = useState("");
  const [noteStatus, setNoteStatus] = useState("saved");
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importTargetId, setImportTargetId] = useState("");
  const [importProgress, setImportProgress] = useState(null);
  const [duplicatePaths, setDuplicatePaths] = useState([]);
  const [importActive, setImportActive] = useState(false);
  const audioRef = useRef(null);
  const playbackRef = useRef({ requestId: 0, project: null, projectId: "", trackId: "", queue: [], index: -1 });
  const shuffleRef = useRef(false);
  const repeatRef = useRef("off");
  const lastTimeUpdateRef = useRef(0);
  const noteTimerRef = useRef(null);
  const noteContextRef = useRef({ key: "", draftText: "", persistedText: "", revision: 0 });
  const noteTextRef = useRef("");
  const noteRevisionRef = useRef(0);
  const noteStoreRef = useRef(null);
  const searchInputRef = useRef(null);
  const allowWindowCloseRef = useRef(false);
  const importActiveProjectsRef = useRef(new Set());
  const lastImportRequestRef = useRef(null);

  if (!noteStoreRef.current) noteStoreRef.current = createNoteStore(window.localStorage);

  const selectedProject = projects.find((project) => project.id === selectedId) ?? null;
  const playingProject = projects.find((project) => project.id === playingProjectId) ?? null;
  const playingTrack = playingProject?.tracks.find((track) => track.id === playingTrackId) ?? null;
  const displayProject = playingProject ?? selectedProject;
  const displayTrack = playingTrack ?? selectedProject?.tracks[0] ?? null;
  const displayTrackIndex = displayProject?.tracks.findIndex((track) => track.id === displayTrack?.id) ?? -1;
  const displayQueueIndex = displayProject && playbackRef.current.projectId === displayProject.id ? playbackRef.current.index : displayTrackIndex;
  const sortedProjects = useMemo(() => {
    return [...projects].sort((left, right) => {
      if (sortMode === "alphabetical") return left.title.localeCompare(right.title, undefined, { sensitivity: "base" });
      if (sortMode === "newest") return right.createdAt - left.createdAt;
      return right.updatedAt - left.updatedAt;
    });
  }, [projects, sortMode]);
  const filteredProjects = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return sortedProjects;
    return sortedProjects.filter((project) => project.title.toLowerCase().includes(normalizedQuery) || project.tracks.some((track) => track.title.toLowerCase().includes(normalizedQuery)));
  }, [query, sortedProjects]);
  const trackMatches = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return new Map(sortedProjects.map((project) => [project.id, normalizedQuery ? project.tracks.find((track) => track.title.toLowerCase().includes(normalizedQuery)) : null]));
  }, [query, sortedProjects]);
  const importProject = projects.find((project) => project.id === importTargetId) ?? selectedProject;
  const noteContextKey = selectedProject ? `${selectedProject.id}:${noteTargetId ?? "project"}` : "";
  const progressValue = durationMs > 0 ? Math.min(100, (elapsedMs / durationMs) * 100) : 0;

  async function reloadProjects(preferredId = selectedId) {
    if (!isTauri()) {
      setProjects([]);
      setLoading(false);
      return [];
    }
    try {
      const nextProjects = (await invoke("listProjects")).map(hydrateProject);
      setProjects(nextProjects);
      playbackRef.current = reconcilePlayingQueue(playbackRef.current, nextProjects.find((project) => project.id === playbackRef.current.projectId));
      setRecoveryMode(false);
      const nextSelection = nextProjects.find((project) => project.id === preferredId) ?? nextProjects[0] ?? null;
      setSelectedId(nextSelection?.id ?? "");
      if (!nextSelection) setActiveView("library");
      setError("");
      return nextProjects;
    } catch (loadError) {
      setProjects([]);
      setError(String(loadError));
      setRecoveryMode(isRecoveryError(loadError));
      return [];
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reloadProjects();
  }, []);

  useEffect(() => {
    const audio = new Audio();
    audio.preload = "metadata";
    audioRef.current = audio;
    return () => {
      audio.pause();
      audio.src = "";
      audioRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = muted ? 0 : Math.max(0, Math.min(1, volume / 100));
    window.localStorage.setItem(PLAYBACK_STORAGE_KEY, JSON.stringify({ projectId: playingProjectId, trackId: playingTrackId, volume, muted }));
  }, [playingProjectId, playingTrackId, volume, muted]);

  useEffect(() => {
    const mediaSession = navigator.mediaSession;
    if (!mediaSession || !displayProject || !displayTrack) return undefined;
    try {
      mediaSession.metadata = new MediaMetadata({
        title: displayTrack.title,
        artist: "OPAL",
        album: displayProject.title,
        artwork: displayProject.artwork ? [{ src: displayProject.artwork, sizes: "512x512", type: "image/png" }] : [],
      });
      mediaSession.playbackState = playbackState === "playing" ? "playing" : "paused";
      const handlers = {
        play: () => { if (playbackState !== "playing") togglePlayback(); },
        pause: () => {
          if (playbackState === "playing") {
            audioRef.current?.pause();
            setPlaybackState("paused");
          }
        },
        previoustrack: playPrevious,
        nexttrack: playNext,
        seekbackward: () => seekBy(-10),
        seekforward: () => seekBy(10),
      };
      Object.entries(handlers).forEach(([action, handler]) => {
        try { mediaSession.setActionHandler(action, handler); } catch { /* WebKit exposes a partial action set. */ }
      });
      return () => {
        Object.keys(handlers).forEach((action) => {
          try { mediaSession.setActionHandler(action, null); } catch { /* Ignore unsupported actions. */ }
        });
      };
    } catch {
      return undefined;
    }
  }, [displayProject?.id, displayProject?.title, displayProject?.artwork, displayTrack?.id, displayTrack?.title, playbackState, playingProjectId, playingTrackId]);

  useEffect(() => {
    const mediaSession = navigator.mediaSession;
    if (!mediaSession || !durationMs || !Number.isFinite(elapsedMs)) return;
    try {
      mediaSession.setPositionState({ duration: Math.max(0.001, durationMs / 1000), playbackRate: 1, position: Math.min(durationMs / 1000, Math.max(0, elapsedMs / 1000)) });
    } catch {
      // Position state is optional and can be rejected while metadata is loading.
    }
  }, [durationMs, elapsedMs]);

  useEffect(() => {
    function isEditableTarget(target) {
      return target?.matches?.("input, textarea, select, button, [contenteditable='true']");
    }
    function handleKeyboardShortcuts(event) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      if (isEditableTarget(event.target)) return;
      if (event.key === " ") {
        event.preventDefault();
        togglePlayback();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        seekBy(-5);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        seekBy(5);
      }
    }
    document.addEventListener("keydown", handleKeyboardShortcuts);
    return () => document.removeEventListener("keydown", handleKeyboardShortcuts);
  }, [displayProject?.id, displayTrack?.id, playbackState, durationMs, playingProjectId, playingTrackId]);

  useEffect(() => {
    window.localStorage.setItem(SORT_STORAGE_KEY, sortMode);
  }, [sortMode]);

  useEffect(() => {
    document.documentElement.classList.toggle("opal-large-type", preferences.largeType);
    document.documentElement.classList.toggle("opal-reduced-motion", preferences.reduceMotion);
    document.documentElement.classList.toggle("opal-softer-glass", preferences.softerGlass);
    window.localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(preferences));
  }, [preferences]);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [activeView]);

  useEffect(() => {
    if (!selectedProject) {
      noteTextRef.current = "";
      setNoteText("");
      noteRevisionRef.current += 1;
      noteContextRef.current = { key: "", draftText: "", persistedText: "", revision: noteRevisionRef.current };
      return;
    }
    const note = noteTargetId ? selectedProject.tracks.find((track) => track.id === noteTargetId)?.note : selectedProject.projectNote;
    const pendingText = noteStoreRef.current.get(noteContextKey);
    const nextText = pendingText ?? note?.text ?? "";
    noteTextRef.current = nextText;
    noteRevisionRef.current += 1;
    noteContextRef.current = { key: noteContextKey, draftText: nextText, persistedText: note?.text ?? "", revision: noteRevisionRef.current };
    setNoteText(nextText);
    setNoteStatus(pendingText !== undefined && pendingText !== (note?.text ?? "") ? "saving" : "saved");
  }, [noteContextKey]);

  useEffect(() => {
    if (!noteContextKey) return undefined;
    if (noteTextRef.current !== noteText) return undefined;
    noteContextRef.current = { ...noteContextRef.current, draftText: noteText };
    if (noteText === noteContextRef.current.persistedText) {
      noteStoreRef.current.remove(noteContextKey);
      return undefined;
    }
    if (!isTauri()) return undefined;
    noteStoreRef.current.edit(noteContextKey, noteText);
    setNoteStatus("saving");
    noteRevisionRef.current += 1;
    if (noteTimerRef.current) clearTimeout(noteTimerRef.current);
    noteTimerRef.current = setTimeout(() => { void flushNoteSave(); }, 650);
    return () => {
      if (noteTimerRef.current) clearTimeout(noteTimerRef.current);
    };
  }, [noteContextKey, noteText]);

  useEffect(() => {
    if (!isTauri()) return undefined;
    let unlisten;
    let cancelled = false;
    getCurrentWindow().onCloseRequested(async (event) => {
      if (allowWindowCloseRef.current) return;
      event.preventDefault();
      await flushNoteSave();
      allowWindowCloseRef.current = true;
      await getCurrentWindow().close();
    }).then((cleanup) => {
      if (cancelled) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return undefined;
    let unlisten;
    let cancelled = false;
    listen("opal://import-progress", (event) => {
      if (!cancelled) setImportProgress((current) => ({ ...(current ?? {}), ...event.payload }));
    }).then((cleanup) => {
      if (cancelled) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, []);

  useEffect(() => {
    if (!isTauri()) return undefined;
    let unlisten;
    let cancelled = false;
    getCurrentWindow().onDragDropEvent((event) => {
      if (event.payload.type === "drop" && activeView === "project" && selectedId && event.payload.paths.length) {
        setImportTargetId(selectedId);
        runImport(selectedId, event.payload.paths, false);
      }
    }).then((cleanup) => {
      if (cancelled) cleanup();
      else unlisten = cleanup;
    });
    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [activeView, selectedId]);

  function applySavedNote(note) {
    setProjects((current) => current.map((project) => {
      if (note.projectId && project.id === note.projectId) return { ...project, projectNote: note };
      if (note.trackId) return { ...project, tracks: project.tracks.map((track) => track.id === note.trackId ? { ...track, note } : track) };
      return project;
    }));
  }

  async function persistNote(contextKey, text) {
    if (!isTauri() || !contextKey) return null;
    const { projectId, trackId } = noteKeyParts(contextKey);
    const revision = noteContextRef.current.key === contextKey ? noteRevisionRef.current : -1;
    try {
      const savedNote = await invoke("saveNote", { projectId, trackId, text });
      const isFresh = shouldApplyNoteSave({
        requestRevision: revision,
        currentRevision: noteRevisionRef.current,
        requestKey: contextKey,
        currentKey: noteContextRef.current.key,
        requestText: text,
        currentDraft: noteContextRef.current.draftText,
      });
      if (!isFresh) return savedNote;
      noteContextRef.current = { ...noteContextRef.current, persistedText: text };
      applySavedNote(savedNote);
      setNoteStatus("saved");
      setError("");
      return savedNote;
    } catch (saveError) {
      const isCurrent = noteContextRef.current.key === contextKey && noteStoreRef.current.get(contextKey) === text;
      if (isCurrent) {
        setNoteStatus("error");
        setError(String(saveError));
      }
      throw saveError;
    }
  }

  async function flushNoteSave() {
    if (noteTimerRef.current) clearTimeout(noteTimerRef.current);
    if (!isTauri()) return null;
    try {
      return await noteStoreRef.current.flush(persistNote);
    } catch (saveError) {
      const current = noteContextRef.current;
      if (current.key && noteStoreRef.current.get(current.key) !== undefined) {
        setNoteStatus("error");
        setError(String(saveError));
      }
      return null;
    }
  }

  async function openProject(projectId = selectedId, trackId = "", noteTrackId = null) {
    if (!projectId || !projects.some((project) => project.id === projectId)) return;
    await flushNoteSave();
    setSelectedId(projectId);
    setFocusedTrackId(trackId);
    setNoteTargetId(noteTrackId);
    setActiveView("project");
  }

  async function returnToLibrary() {
    await flushNoteSave();
    setActiveView("library");
    setFocusedTrackId("");
  }

  async function openProjectsView() {
    await flushNoteSave();
    setActiveView("projects");
  }

  async function changeNoteTarget(trackId) {
    await flushNoteSave();
    setNoteTargetId(trackId);
  }

  function handleNoteChange(nextText) {
    noteTextRef.current = nextText;
    setNoteText(nextText);
    if (noteContextKey && isTauri()) {
      noteContextRef.current = { ...noteContextRef.current, draftText: nextText };
      noteRevisionRef.current += 1;
      noteStoreRef.current.edit(noteContextKey, nextText);
      setNoteStatus("saving");
    }
  }

  function handleWindowMouseDown(event) {
    if (!isTauri() || event.button !== 0) return;
    if (event.target?.closest?.("button, input, textarea, label, select, a, [data-popover]")) return;
    getCurrentWindow().startDragging().catch(() => {});
  }

  function startPlayback(project, track, index = project.tracks.findIndex((item) => item.id === track.id), queueOverride = null) {
    const audio = audioRef.current;
    const requestId = playbackRef.current.requestId + 1;
    const queue = queueOverride ?? (shuffleRef.current ? shuffleQueue(project.tracks, track.id, project.id) : project.tracks);
    const queueIndex = queueOverride ? index : queue.findIndex((item) => item.id === track.id);
    playbackRef.current = { requestId, project, projectId: project.id, trackId: track.id, queue, index: queueIndex };
    setPlayingProjectId(project.id);
    setPlayingTrackId(track.id);
    setElapsedMs(0);
    setDurationMs(track.durationMs || 0);
    setPlaybackError("");
    setPlaybackState("loading");
    if (!audio) return;
    audio.pause();
    audio.onloadedmetadata = () => {
      if (!isCurrentPlaybackRequest(requestId, playbackRef.current.requestId)) return;
      if (Number.isFinite(audio.duration)) setDurationMs(Math.round(audio.duration * 1000));
    };
    audio.ontimeupdate = () => {
      if (!isCurrentPlaybackRequest(requestId, playbackRef.current.requestId)) return;
      const now = performance.now();
      if (now - lastTimeUpdateRef.current < 100) return;
      lastTimeUpdateRef.current = now;
      setElapsedMs(Math.round(audio.currentTime * 1000));
    };
    audio.onended = () => {
      if (!isCurrentPlaybackRequest(requestId, playbackRef.current.requestId)) return;
      setElapsedMs(Number.isFinite(audio.duration) ? Math.round(audio.duration * 1000) : track.durationMs || 0);
      const nextIndex = repeatQueueIndex(playbackRef.current.index, playbackRef.current.queue.length, repeatRef.current);
      const nextTrack = nextIndex === null ? null : playbackRef.current.queue[nextIndex];
      if (nextTrack && nextIndex !== null) startPlayback(playbackRef.current.project, nextTrack, nextIndex, playbackRef.current.queue);
      else {
        setPlaybackState("ended");
        setPlaybackError("");
      }
    };
    audio.onerror = () => {
      if (!isCurrentPlaybackRequest(requestId, playbackRef.current.requestId)) return;
      setPlaybackState("error");
      setPlaybackError("This file could not be played.");
    };
    if (!isTauri() || !track.managedFilePath) {
      setPlaybackState("error");
      setPlaybackError(isTauri() ? "The managed audio file is missing." : "Open the native app to play local audio.");
      return;
    }
    audio.src = convertFileSrc(track.managedFilePath);
    audio.load();
    audio.play().then(() => {
      if (isCurrentPlaybackRequest(requestId, playbackRef.current.requestId)) setPlaybackState("playing");
    }).catch(() => {
      if (isCurrentPlaybackRequest(requestId, playbackRef.current.requestId)) {
        setPlaybackState("error");
        setPlaybackError("This file could not be played.");
      }
    });
  }

  function stopPlayback() {
    const audio = audioRef.current;
    playbackRef.current = { ...playbackRef.current, requestId: playbackRef.current.requestId + 1, project: null, projectId: "", trackId: "", queue: [], index: -1 };
    if (audio) {
      audio.pause();
      audio.src = "";
      audio.onloadedmetadata = null;
      audio.ontimeupdate = null;
      audio.onended = null;
      audio.onerror = null;
    }
    setPlayingProjectId("");
    setPlayingTrackId("");
    setPlaybackState("idle");
    setPlaybackError("");
    setElapsedMs(0);
    setDurationMs(0);
  }

  function updatePlayingQueue(nextProject) {
    playbackRef.current = reconcilePlayingQueue(playbackRef.current, nextProject);
  }

  function toggleShuffle() {
    setShuffleEnabled((enabled) => {
      const nextEnabled = !enabled;
      shuffleRef.current = nextEnabled;
      const current = playbackRef.current;
      if (current.project) {
        const queue = nextEnabled ? shuffleQueue(current.project.tracks, current.trackId, current.project.id) : current.project.tracks;
        const index = queue.findIndex((item) => item.id === current.trackId);
        playbackRef.current = { ...current, queue, index };
      }
      return nextEnabled;
    });
  }

  function cycleRepeatMode() {
    setRepeatMode((mode) => {
      const nextMode = mode === "off" ? "project" : mode === "project" ? "track" : "off";
      repeatRef.current = nextMode;
      return nextMode;
    });
  }

  function togglePlayback() {
    if (!displayProject || !displayTrack) return;
    const audio = audioRef.current;
    const isCurrent = playingProjectId === displayProject.id && playingTrackId === displayTrack.id;
    if (!isCurrent || playbackState === "ended" || playbackState === "error") {
      startPlayback(displayProject, displayTrack, displayTrackIndex >= 0 ? displayTrackIndex : 0);
      return;
    }
    if (playbackState === "playing") {
      audio?.pause();
      setPlaybackState("paused");
    } else if (audio?.src) {
      const requestId = playbackRef.current.requestId;
      audio.play().then(() => {
        if (isCurrentPlaybackRequest(requestId, playbackRef.current.requestId)) setPlaybackState("playing");
      }).catch(() => {
        if (!isCurrentPlaybackRequest(requestId, playbackRef.current.requestId)) return;
        setPlaybackState("error");
        setPlaybackError("This file could not be played.");
      });
    } else {
      startPlayback(displayProject, displayTrack, displayTrackIndex >= 0 ? displayTrackIndex : 0);
    }
  }

  function playNext() {
    const current = playbackRef.current;
    if (!current.project || !current.queue.length) {
      if (displayProject && displayTrack) startPlayback(displayProject, displayTrack, displayTrackIndex >= 0 ? displayTrackIndex : 0);
      return;
    }
    const nextIndex = repeatQueueIndex(current.index, current.queue.length, repeatRef.current === "track" ? "project" : repeatRef.current);
    if (nextIndex !== null && current.queue[nextIndex]) startPlayback(current.project, current.queue[nextIndex], nextIndex, current.queue);
    else {
      audioRef.current?.pause();
      setPlaybackState("ended");
    }
  }

  function playPrevious() {
    const current = playbackRef.current;
    const audio = audioRef.current;
    const previousIndex = previousQueueIndex(current.index, audio?.currentTime ?? 0, current.queue.length);
    if (current.project && audio && previousIndex === current.index) {
      audio.currentTime = 0;
      setElapsedMs(0);
    } else if (current.project && previousIndex !== null) startPlayback(current.project, current.queue[previousIndex], previousIndex, current.queue);
    else if (displayProject && displayTrack) startPlayback(displayProject, displayTrack, displayTrackIndex >= 0 ? displayTrackIndex : 0);
  }

  function seekBy(seconds) {
    const audio = audioRef.current;
    if (!audio || !durationMs) return;
    const nextElapsed = Math.min(durationMs, Math.max(0, (audio.currentTime * 1000) + (seconds * 1000)));
    audio.currentTime = nextElapsed / 1000;
    setElapsedMs(nextElapsed);
  }

  function seekPlayback(event) {
    const audio = audioRef.current;
    if (!audio || !durationMs) return;
    const nextElapsed = (Number(event.target.value) / 100) * durationMs;
    audio.currentTime = nextElapsed / 1000;
    setElapsedMs(nextElapsed);
  }

  async function createProject(title, description) {
    if (!isTauri()) {
      setError("Open the native OPAL app to edit the local library.");
      return;
    }
    try {
      const created = hydrateProject(await invoke("createProject", { title, description }));
      await reloadProjects(created.id);
      setSelectedId(created.id);
      setActiveView("project");
      setCreateOpen(false);
      setError("");
    } catch (createError) {
      setError(String(createError));
    }
  }

  async function updateProject(title, description) {
    if (!selectedProject || !isTauri()) {
      setError("Open the native OPAL app to edit the local library.");
      return;
    }
    try {
      await invoke("updateProject", { projectId: selectedProject.id, title, description });
      await reloadProjects(selectedProject.id);
      setEditOpen(false);
      setError("");
    } catch (updateError) {
      setError(String(updateError));
    }
  }

  async function renameTrack(trackId, title) {
    if (!selectedProject || !isTauri()) {
      setError("Open the native OPAL app to edit the local library.");
      return;
    }
    try {
      await invoke("updateTrackTitle", { projectId: selectedProject.id, trackId, title });
      const refreshed = await reloadProjects(selectedProject.id);
      const nextProject = refreshed.find((project) => project.id === selectedProject.id);
      if (nextProject) updatePlayingQueue(nextProject);
      setError("");
    } catch (renameError) {
      setError(String(renameError));
    }
  }

  async function reorderTracks(trackIds) {
    if (!selectedProject || !isTauri()) {
      setError("Open the native OPAL app to edit the local library.");
      return;
    }
    try {
      const updated = hydrateProject(await invoke("reorderTracks", { projectId: selectedProject.id, trackIds }));
      setProjects((current) => current.map((project) => project.id === updated.id ? updated : project));
      updatePlayingQueue(updated);
      setError("");
    } catch (reorderError) {
      setError(String(reorderError));
    }
  }

  async function removeTrack(project, track) {
    if (!isTauri()) {
      setError("Open the native OPAL app to edit the local library.");
      return;
    }
    const wasPlaying = playingProjectId === project.id && playingTrackId === track.id;
    setConfirmState({
      title: "Remove track",
      message: `Remove “${track.title}” from “${project.title}”? The OPAL-managed copy will be deleted. Your original file stays untouched.`,
      confirmLabel: "Remove track",
      onConfirm: async () => {
        await removeTrackConfirmed(project, track, wasPlaying);
      },
    });
  }

  async function removeTrackConfirmed(project, track, wasPlaying) {
    try {
      if (wasPlaying) stopPlayback();
      const updated = hydrateProject(await invoke("deleteTrack", { projectId: project.id, trackId: track.id }));
      setProjects((current) => current.map((item) => item.id === updated.id ? updated : item));
      if (!wasPlaying) updatePlayingQueue(updated);
      noteStoreRef.current.remove(`${project.id}:${track.id}`);
      if (noteTargetId === track.id) setNoteTargetId(null);
      setError("");
    } catch (removeError) {
      setError(String(removeError));
    }
  }

  async function removeProject(project) {
    if (!isTauri()) {
      setError("Open the native OPAL app to edit the local library.");
      return;
    }
    setConfirmState({
      title: "Delete project",
      message: `Delete “${project.title}”? Its OPAL-managed audio and artwork copies will be deleted. Your original files stay untouched.`,
      confirmLabel: "Delete project",
      destructive: true,
      onConfirm: async () => {
        await removeProjectConfirmed(project);
      },
    });
  }

  async function removeProjectConfirmed(project) {
    try {
      if (playingProjectId === project.id) stopPlayback();
      await invoke("deleteProject", { projectId: project.id });
      noteStoreRef.current.removePrefix(`${project.id}:`);
      setSelectedId("");
      setActiveView("library");
      await reloadProjects("");
      setError("");
    } catch (removeError) {
      setError(String(removeError));
    }
  }

  async function pickArtwork() {
    if (!selectedProject || !isTauri()) return;
    const choice = await open({ multiple: false, directory: false, filters: ARTWORK_FILTERS });
    if (typeof choice !== "string") return;
    try {
      await invoke("setProjectArtwork", { projectId: selectedProject.id, sourcePath: choice });
      await reloadProjects(selectedProject.id);
      setError("");
    } catch (artworkError) {
      setError(String(artworkError));
    }
  }

  async function removeArtwork() {
    if (!selectedProject || !isTauri()) {
      setError("Open the native OPAL app to edit the local library.");
      return;
    }
    setConfirmState({
      title: "Remove artwork",
      message: `Remove the artwork from “${selectedProject.title}”? OPAL will return to its default cover; your original image stays untouched.`,
      confirmLabel: "Remove artwork",
      destructive: true,
      onConfirm: async () => {
        try {
          await invoke("removeProjectArtwork", { projectId: selectedProject.id });
          await reloadProjects(selectedProject.id);
          setError("");
        } catch (artworkError) {
          setError(String(artworkError));
        }
      },
    });
  }

  function togglePreference(key) {
    setPreferences((current) => ({ ...current, [key]: !current[key] }));
  }

  async function openProfile() {
    const shouldOpen = !profileOpen;
    setProfileOpen(shouldOpen);
    if (shouldOpen) void refreshStorageInfo();
  }

  async function refreshStorageInfo() {
    if (!isTauri()) return;
    try {
      setStorageError("");
      setStorageInfo(await invoke("getStorageInfo"));
    } catch (storageLoadError) {
      setStorageError(String(storageLoadError));
      setError(String(storageLoadError));
    }
  }

  async function revealStorageFolder() {
    if (!isTauri()) {
      setError("Open the native OPAL app to reveal local storage.");
      return;
    }
    try {
      await invoke("revealStorageFolder");
    } catch (revealError) {
      setError(String(revealError));
    }
  }

  async function exportLibraryBackup() {
    if (!isTauri()) {
      setError("Open the native OPAL app to export a library backup.");
      return;
    }
    const destination = await open({ multiple: false, directory: true });
    if (typeof destination !== "string") return;
    try {
      const backupPath = await invoke("exportBackup", { destination });
      setNotice(`Backup exported to ${backupPath}`);
      setError("");
      await refreshStorageInfo();
    } catch (backupError) {
      setError(String(backupError));
    }
  }

  async function restoreLibraryBackup() {
    if (!isTauri()) {
      setError("Open the native OPAL app to restore a library backup.");
      return;
    }
    const sourcePath = await open({ multiple: false, directory: true });
    if (typeof sourcePath !== "string") return;
    setConfirmState({
      title: "Restore library",
      message: "Restore this OPAL backup? The current local library will be kept as a recoverable pre-restore backup.",
      confirmLabel: "Restore backup",
      destructive: true,
      onConfirm: async () => {
        try {
          await invoke("restoreBackup", { sourcePath });
          setRecoveryMode(false);
          await reloadProjects("");
          setProfileOpen(false);
          setError("");
        } catch (restoreError) {
          setError(String(restoreError));
        }
      },
    });
  }

  async function openDiagnostics() {
    if (!isTauri()) {
      setError("Diagnostics are available in the native OPAL app.");
      return;
    }
    try {
      setDiagnostics(await invoke("getDiagnostics"));
      setDiagnosticsOpen(true);
      setProfileOpen(false);
    } catch (diagnosticsError) {
      setError(String(diagnosticsError));
    }
  }

  async function retryStorage() {
    if (!isTauri()) return;
    try {
      await invoke("retryStorage");
      setRecoveryMode(false);
      await reloadProjects("");
      setError("");
    } catch (retryError) {
      setError(String(retryError));
    }
  }

  async function pickAudioFiles(projectId = selectedProject?.id) {
    if (!projectId || !isTauri()) return;
    if (importActiveProjectsRef.current.has(projectId)) {
      setImportTargetId(projectId);
      setImportOpen(true);
      return;
    }
    const choice = await open({ multiple: true, directory: false, filters: AUDIO_FILTERS });
    const paths = Array.isArray(choice) ? choice : choice ? [choice] : [];
    if (paths.length) runImport(projectId, paths, false);
  }

  async function runImport(projectId, paths, allowDuplicates) {
    if (!paths.length || importActiveProjectsRef.current.has(projectId)) {
      setImportTargetId(projectId);
      setImportOpen(true);
      return;
    }
    importActiveProjectsRef.current.add(projectId);
    setImportActive(true);
    setImportTargetId(projectId);
    setImportOpen(true);
    setDuplicatePaths([]);
    lastImportRequestRef.current = { projectId, paths: [...paths], allowDuplicates };
    setImportProgress({ projectId, current: 0, total: paths.length, fileName: "", status: "processing", message: "", results: [] });
    try {
      const summary = await invoke("importAudioFiles", { projectId, paths, allowDuplicates });
      const refreshedProjects = await reloadProjects(projectId);
      const importedIds = new Set(summary.results.map((result) => result.track?.id).filter(Boolean));
      const importedTracks = refreshedProjects.find((project) => project.id === projectId)?.tracks.filter((track) => importedIds.has(track.id)) ?? [];
      importedTracks.forEach((track) => {
        if (!track.managedFilePath || readCachedWaveform(track)) return;
        void cacheWaveform(track, convertFileSrc(track.managedFilePath)).catch(() => {});
      });
      setDuplicatePaths(summary.duplicatePaths ?? []);
      setImportProgress((current) => ({ ...(current ?? {}), current: paths.length, total: paths.length, status: summary.duplicatePaths?.length ? "duplicates" : "complete", message: summary.duplicatePaths?.length ? "Duplicate files found." : `${summary.importedCount} imported.`, results: summary.results ?? [] }));
      setError("");
    } catch (importError) {
      setImportProgress((current) => ({ ...(current ?? {}), status: "error", message: String(importError) }));
      setError(String(importError));
    } finally {
      importActiveProjectsRef.current.delete(projectId);
      setImportActive(importActiveProjectsRef.current.size > 0);
    }
  }

  function closeImport() {
    setImportOpen(false);
  }

  const visibleSelection = filteredProjects.find((project) => project.id === selectedId)?.id ?? filteredProjects[0]?.id ?? "";

  return <div className="opal-app">
    <div className="ambient-field" aria-hidden="true" />
    <header className="topbar" data-tauri-drag-region="deep" onMouseDown={handleWindowMouseDown}>
      <div className="topbar-left"><button className="brand-lockup" type="button" onClick={returnToLibrary} aria-label="Open OPAL library"><span className="brand-mark">O</span><span className="brand-name">OPAL</span></button><label className="search-field"><MagnifyingGlass size={14} weight="regular" /><input ref={searchInputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" />{query && <button type="button" className="clear-search" onClick={() => setQuery("")} aria-label="Clear search"><X size={13} /></button>}</label></div>
      <nav className="top-navigation" aria-label="Primary navigation"><button type="button" className={activeView === "library" ? "is-active" : ""} onClick={returnToLibrary}>Library</button><button type="button" className={activeView === "projects" ? "is-active" : ""} onClick={openProjectsView}>Projects</button></nav>
      <div className="topbar-actions"><button type="button" className={`topbar-import ${importActive ? "is-busy" : ""}`} onClick={() => importActive ? setImportOpen(true) : (selectedProject ? pickAudioFiles() : setCreateOpen(true))}><Plus size={14} />{importActive ? "Importing…" : "Import"}</button><button type="button" className="profile-button" onClick={openProfile} aria-label="Open OPAL settings" aria-expanded={profileOpen}>SM</button>{profileOpen && <ProfilePopover nativeAvailable={isTauri()} storageInfo={storageInfo} storageError={storageError} preferences={preferences} importProgress={importProgress} onTogglePreference={togglePreference} onRevealFolder={revealStorageFolder} onExportBackup={exportLibraryBackup} onRestoreBackup={restoreLibraryBackup} onRetryStorage={refreshStorageInfo} onDiagnostics={openDiagnostics} onClose={() => setProfileOpen(false)} />}</div>
    </header>
    {error && <div className="error-banner" role="alert"><span>{error}</span><button type="button" onClick={() => setError("")} aria-label="Dismiss message"><X size={14} /></button></div>}
    {notice && <div className="notice-banner" role="status"><span>{notice}</span><button type="button" onClick={() => setNotice("")} aria-label="Dismiss message"><X size={14} /></button></div>}
    <main className="stage">{recoveryMode ? <RecoveryView onRevealFolder={revealStorageFolder} onRestore={restoreLibraryBackup} onRetry={retryStorage} /> : activeView === "project" && selectedProject ? <ProjectView project={selectedProject} playingTrackId={playingProjectId === selectedProject.id ? playingTrackId : ""} focusedTrackId={focusedTrackId} notesOpen={notesOpen} noteTargetId={noteTargetId} noteText={noteText} noteStatus={noteStatus} nativeAvailable={isTauri()} onBack={returnToLibrary} onTrackSelect={(track) => startPlayback(selectedProject, track)} onPlay={() => selectedProject.tracks[0] && startPlayback(selectedProject, selectedProject.tracks[0], 0)} onToggleNotes={() => setNotesOpen((openState) => !openState)} onNoteChange={handleNoteChange} onNoteTargetChange={changeNoteTarget} onImport={() => pickAudioFiles(selectedProject.id)} onEditProject={() => setEditOpen(true)} onEditArtwork={pickArtwork} onRemoveArtwork={removeArtwork} onRemoveProject={() => removeProject(selectedProject)} onRenameTrack={renameTrack} onReorderTracks={reorderTracks} onRemoveTrack={(track) => removeTrack(selectedProject, track)} /> : activeView === "projects" ? <ProjectsView loading={loading} projects={filteredProjects} query={query} sortMode={sortMode} onSortChange={setSortMode} onOpenProject={openProject} onPlayProject={(project) => project.tracks[0] && startPlayback(project, project.tracks[0], 0)} onCreateProject={() => setCreateOpen(true)} onClearSearch={() => setQuery("")} /> : <LibraryView loading={loading} projects={filteredProjects} selectedId={visibleSelection} query={query} sortMode={sortMode} trackMatches={trackMatches} onSortChange={setSortMode} onProjectSelect={setSelectedId} onOpenProject={openProject} onCreateProject={() => setCreateOpen(true)} onImport={() => (selectedProject ? pickAudioFiles(selectedProject.id) : setCreateOpen(true))} onClearSearch={() => setQuery("")} onStep={(step) => { if (!filteredProjects.length) return; const current = filteredProjects.findIndex((project) => project.id === visibleSelection); const next = (current + step + filteredProjects.length) % filteredProjects.length; setSelectedId(filteredProjects[next].id); }} />}</main>
    {displayProject && displayTrack && <Player project={displayProject} track={displayTrack} status={playbackState} playbackError={playbackError} isPlaying={playbackState === "playing"} progress={progressValue} elapsedMs={elapsedMs} durationMs={durationMs || displayTrack.durationMs} volume={volume} muted={muted} volumeOpen={volumeOpen} queueOpen={queueOpen} menuOpen={playerMenuOpen} shuffleEnabled={shuffleEnabled} repeatMode={repeatMode} onTogglePlay={togglePlayback} onPrevious={playPrevious} onNext={playNext} onProgressChange={seekPlayback} onVolumeChange={(event) => { setVolume(Number(event.target.value)); setMuted(false); }} onToggleMute={() => setMuted((value) => !value)} onToggleVolume={() => setVolumeOpen((openState) => !openState)} onToggleQueue={() => setQueueOpen((openState) => !openState)} onToggleMenu={() => setPlayerMenuOpen((openState) => !openState)} onToggleShuffle={toggleShuffle} onToggleRepeat={cycleRepeatMode} onOpenProject={() => openProject(displayProject.id)} onShowTrack={() => openProject(displayProject.id, displayTrack.id)} onOpenNotes={() => openProject(displayProject.id, displayTrack.id, displayTrack.id)} onRevealFile={async () => { try { await invoke("revealManagedFile", { managedFileRef: displayTrack.managedFileRef }); } catch (revealError) { setError(String(revealError)); } }} onShowInfo={() => setTrackInfo({ project: displayProject, track: displayTrack })} />}
    {queueOpen && displayProject && <QueuePopover project={displayProject} currentIndex={displayQueueIndex} onSelect={(track, index) => { startPlayback(displayProject, track, index); setQueueOpen(false); }} onClose={() => setQueueOpen(false)} />}
    {createOpen && <CreateProjectPrompt onClose={() => setCreateOpen(false)} onCreate={createProject} />}
    {editOpen && selectedProject && <ProjectEditorPrompt project={selectedProject} onClose={() => setEditOpen(false)} onSave={updateProject} />}
    {importOpen && importProject && <ImportPrompt project={importProject} progress={importProgress} duplicatePaths={duplicatePaths} onClose={closeImport} onChooseFiles={() => pickAudioFiles(importProject.id)} onRetryImport={() => { const request = lastImportRequestRef.current; if (request) runImport(request.projectId, request.paths, request.allowDuplicates); }} onImportDuplicates={() => runImport(importProject.id, duplicatePaths, true)} onSkipDuplicates={() => { setDuplicatePaths([]); setImportProgress((current) => ({ ...(current ?? {}), status: "complete", message: "Duplicates skipped." })); }} />}
    {trackInfo && <TrackInfoDialog project={trackInfo.project} track={trackInfo.track} onClose={() => setTrackInfo(null)} />}
    {diagnosticsOpen && <DiagnosticsDialog diagnostics={diagnostics} onClose={() => setDiagnosticsOpen(false)} />}
    {confirmState && <ConfirmDialog {...confirmState} busy={confirmBusy} onClose={() => { if (!confirmBusy) setConfirmState(null); }} onConfirm={async () => { if (confirmBusy) return; const action = confirmState.onConfirm; setConfirmBusy(true); try { await action(); setConfirmState(null); } finally { setConfirmBusy(false); } }} />}
  </div>;
}

function ProjectsView({ loading, projects: visibleProjects, query, sortMode, onSortChange, onOpenProject, onPlayProject, onCreateProject, onClearSearch }) {
  if (loading) return <section className="projects-screen view-stack loading-library"><div className="library-loading glass"><CircleNotch size={23} weight="thin" /></div></section>;
  const hasSearch = Boolean(query.trim());
  return <section className="projects-screen view-stack">
    <div className="projects-heading">
      <div><h1>Projects</h1></div>
      <div className="projects-heading-actions"><label className="sort-control"><span>Sort</span><select value={sortMode} onChange={(event) => onSortChange(event.target.value)} aria-label="Sort projects"><option value="updated">Recently updated</option><option value="newest">Newest</option><option value="alphabetical">A–Z</option></select><CaretDown size={13} /></label><button className="button button-primary projects-new-button" type="button" onClick={onCreateProject}><Plus size={14} />New project</button></div>
    </div>
    {!visibleProjects.length ? <div className="projects-empty glass"><FolderOpen size={27} weight="thin" /><h2>{hasSearch ? "No projects found" : "Your collection is empty"}</h2><p>{hasSearch ? <>No project matches “{query}”.</> : "Create a project to start building your collection."}</p><button className="button button-primary" type="button" onClick={hasSearch ? onClearSearch : onCreateProject}>{hasSearch ? "Clear search" : "Create project"}</button></div> : <div className="projects-grid">{visibleProjects.map((project) => <article className="project-card" key={project.id}><div className="project-card-art"><button className="project-card-open" type="button" onClick={() => onOpenProject(project.id)} aria-label={`Open ${project.title}`}><img src={project.artwork} alt="" /></button><button className="project-card-play" type="button" onClick={() => onPlayProject(project)} aria-label={`Play ${project.title}`} disabled={!project.count}><Play size={17} weight="fill" /></button></div><div className="project-card-meta"><button className="project-card-title" type="button" onClick={() => onOpenProject(project.id)}>{project.title}</button><div className="project-card-subline"><span>{project.count} {project.count === 1 ? "track" : "tracks"}</span><span>{project.duration}</span></div></div></article>)}<button className="project-create-card" type="button" onClick={onCreateProject}><span><Plus size={20} /></span><strong>New project</strong></button></div>}
  </section>;
}

function LibraryView({ loading, projects: visibleProjects, selectedId, query, sortMode, trackMatches, onSortChange, onProjectSelect, onOpenProject, onCreateProject, onImport, onClearSearch, onStep }) {
  if (loading) return <section className="library-screen view-stack loading-library"><div className="library-loading glass"><CircleNotch size={23} weight="thin" /></div></section>;
  if (!visibleProjects.length) {
    const hasSearch = Boolean(query.trim());
    return <section className="library-screen view-stack empty-library-screen"><div className="empty-library glass"><NotePencil size={27} weight="thin" /><h1>{hasSearch ? "No projects found" : "Your library is empty"}</h1><p>{hasSearch ? <>No project matches “{query}”.</> : "Create a project to start."}</p><div className="empty-library-actions"><button className="button button-primary" type="button" onClick={hasSearch ? onClearSearch : onCreateProject}>{hasSearch ? "Clear search" : "Create project"}</button>{!hasSearch && <button className="text-action" type="button" onClick={onImport}>Import audio <Plus size={14} /></button>}</div></div></section>;
  }
  const selected = visibleProjects.find((project) => project.id === selectedId) ?? visibleProjects[0];
  if (visibleProjects.length > 6) {
    return <SleeveWall projects={visibleProjects} selectedId={selected.id} query={query} sortMode={sortMode} trackMatches={trackMatches} onSortChange={onSortChange} onProjectSelect={onProjectSelect} onOpenProject={onOpenProject} onCreateProject={onCreateProject} onImport={onImport} />;
  }
  const cards = [selected, ...visibleProjects.filter((project) => project.id !== selected.id).slice(0, 3)];
  return <section className="library-screen view-stack"><div className="library-hero-copy"><div className="library-heading-row"><h1>Library</h1><label className="sort-control"><span>Sort</span><select value={sortMode} onChange={(event) => onSortChange(event.target.value)} aria-label="Sort projects"><option value="updated">Recently updated</option><option value="newest">Newest</option><option value="alphabetical">A–Z</option></select><CaretDown size={13} /></label></div></div><div className="carousel-wrap"><button type="button" className="carousel-control carousel-control-left" onClick={() => onStep(-1)} aria-label="Previous project"><CaretLeft size={22} /></button><div className="sleeve-orbit" aria-label="Project artwork selection">{cards.map((project, index) => <button type="button" key={project.id} className={`sleeve sleeve-position-${index} ${project.id === selected.id ? "is-selected" : ""}`} onClick={() => onProjectSelect(project.id)} onDoubleClick={() => onOpenProject(project.id, trackMatches.get(project.id)?.id ?? "")} aria-label={`Select ${project.title}`}><span className="sleeve-image-wrap"><img src={project.artwork} alt="" /></span><span className="sleeve-meta"><strong>{project.title}</strong><small>{project.count} tracks</small></span></button>)}</div><button type="button" className="carousel-control carousel-control-right" onClick={() => onStep(1)} aria-label="Next project"><CaretRight size={22} /></button></div><div className="carousel-caption"><h2>{selected.title}</h2><p>{selected.count} tracks · {selected.duration}</p><button className="text-action" type="button" onClick={() => onOpenProject(selected.id, trackMatches.get(selected.id)?.id ?? "")}>Open project <ArrowUpRight size={15} /></button></div><div className="library-rail"><div className="rail-heading"><span>Projects</span></div><div className="rail-projects">{visibleProjects.map((project) => { const match = trackMatches.get(project.id); return <button type="button" className={project.id === selected.id ? "is-active" : ""} key={project.id} onClick={() => onOpenProject(project.id, match?.id ?? "")}><img src={project.artwork} alt="" /><span><strong>{project.title}</strong>{match && <small className="search-hit">{match.title}</small>}</span><ArrowUpRight size={14} /></button>; })}</div><button className="rail-import" type="button" onClick={onImport}><Plus size={17} /><span>Import audio</span></button></div></section>;
}

function SleeveWall({ projects, selectedId, query, sortMode, trackMatches, onSortChange, onProjectSelect, onOpenProject, onCreateProject, onImport }) {
  return <section className="library-screen sleeve-wall-screen view-stack">
    <div className="library-heading-row sleeve-wall-heading"><div><span className="eyebrow">A gathered collection</span><h1>Library</h1></div><div className="sleeve-wall-actions"><label className="sort-control"><span>Sort</span><select value={sortMode} onChange={(event) => onSortChange(event.target.value)} aria-label="Sort projects"><option value="updated">Recently updated</option><option value="newest">Newest</option><option value="alphabetical">A–Z</option></select><CaretDown size={13} /></label><button className="button button-ghost" type="button" onClick={onCreateProject}><Plus size={14} />New project</button></div></div>
    <div className="sleeve-wall" aria-label="Project sleeve wall">{projects.map((project) => { const match = trackMatches.get(project.id); return <article className={`wall-sleeve ${project.id === selectedId ? "is-selected" : ""}`} key={project.id}><button className="wall-sleeve-open" type="button" onClick={() => { onProjectSelect(project.id); onOpenProject(project.id, match?.id ?? ""); }} aria-label={`Open ${project.title}`}><img src={project.artwork} alt="" /><span className="wall-sleeve-glint" aria-hidden="true" /></button><div className="wall-sleeve-meta"><strong title={project.title}>{project.title}</strong><span>{project.count} tracks <em>·</em> {project.duration}</span>{match && <small className="search-hit">Match: {match.title}</small>}</div></article>; })}<button className="wall-create-card" type="button" onClick={onCreateProject}><Plus size={22} /><strong>New project</strong><span>Keep the wall growing</span></button></div>
    <div className="sleeve-wall-footer"><span>{projects.length} projects</span><button className="rail-import" type="button" onClick={onImport}><Plus size={17} /><span>Import audio</span></button><span>{query ? `Results for “${query}”` : "Local library"}</span></div>
  </section>;
}

function ProjectView({ project, playingTrackId, focusedTrackId, notesOpen, noteTargetId, noteText, noteStatus, nativeAvailable, onBack, onTrackSelect, onPlay, onToggleNotes, onNoteChange, onNoteTargetChange, onImport, onEditProject, onEditArtwork, onRemoveArtwork, onRemoveProject, onRenameTrack, onReorderTracks, onRemoveTrack }) {
  const [editingTrackId, setEditingTrackId] = useState("");
  const [editingTitle, setEditingTitle] = useState("");
  const [draggedTrackId, setDraggedTrackId] = useState("");
  const [trackMenuId, setTrackMenuId] = useState("");

  useEffect(() => {
    if (!focusedTrackId) return undefined;
    const timer = setTimeout(() => document.getElementById(`track-${focusedTrackId}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 100);
    return () => clearTimeout(timer);
  }, [focusedTrackId]);

  function startEditing(track) {
    setEditingTrackId(track.id);
    setEditingTitle(track.title);
  }

  async function finishEditing(track) {
    const title = editingTitle.trim();
    setEditingTrackId("");
    if (title && title !== track.title) await onRenameTrack(track.id, title);
  }

  function moveTrack(index, direction) {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= project.tracks.length) return;
    const ids = project.tracks.map((track) => track.id);
    [ids[index], ids[nextIndex]] = [ids[nextIndex], ids[index]];
    onReorderTracks(ids);
  }

  function dropTrack(targetId) {
    if (!draggedTrackId || draggedTrackId === targetId) return;
    const ids = project.tracks.map((track) => track.id).filter((id) => id !== draggedTrackId);
    const targetIndex = ids.indexOf(targetId);
    ids.splice(targetIndex, 0, draggedTrackId);
    setDraggedTrackId("");
    onReorderTracks(ids);
  }

  const noteLabel = noteTargetId ? project.tracks.find((track) => track.id === noteTargetId)?.title ?? "Track" : "Project";
  return <section className="project-screen view-stack">
    <div className="project-topline"><button className="back-action" type="button" onClick={onBack}><ArrowLeft size={16} />Library</button><button className="delete-project-action" type="button" onClick={onRemoveProject}><Trash size={14} />Delete project</button></div>
    <div className="project-detail-layout">
      <div className="project-cover-column"><div className="project-sleeve-shell"><img className="project-sleeve" src={project.artwork} alt={`${project.title} artwork`} /></div></div>
      <div className="project-main-column">
        <div className="project-header"><div><h1>{project.title}</h1><p>{project.count} tracks <span>/</span> {project.duration} <span>/</span> {project.year}</p></div><div className="heading-actions"><button className="button button-ghost" type="button" onClick={onToggleNotes} aria-expanded={notesOpen}><NotePencil size={14} />{notesOpen ? "Hide notes" : "Show notes"}</button><button className="button button-ghost" type="button" onClick={onEditProject}>Edit details</button><button className="button button-ghost" type="button" onClick={onEditArtwork}><ImageSquare size={14} />Artwork</button>{project.artworkRef && <button className="button button-danger" type="button" onClick={onRemoveArtwork}><Trash size={14} />Remove</button>}<button className="button button-primary" type="button" onClick={onPlay} disabled={!project.count}><Play size={14} weight="fill" />Play</button></div></div>
        {project.description && <p className="project-description project-description-inline">{project.description}</p>}
        <div className="project-quick-actions"><button className="project-add-tracks" type="button" onClick={onImport}><Plus size={18} />Add tracks</button></div>
        <div className={`project-workspace ${notesOpen ? "" : "notes-closed"}`}><div className="tracklist-panel"><div className="section-heading"><h2>Tracks</h2><span className="section-count">{project.count} {project.count === 1 ? "track" : "tracks"}</span></div><div className="track-list">{project.tracks.map((track, index) => <div className={`track-row ${playingTrackId === track.id ? "is-current" : ""} ${focusedTrackId === track.id ? "is-search-match" : ""} ${draggedTrackId === track.id ? "is-dragging" : ""}`} id={`track-${track.id}`} key={track.id} draggable={!editingTrackId} onDragStart={() => setDraggedTrackId(track.id)} onDragEnd={() => setDraggedTrackId("")} onDragOver={(event) => event.preventDefault()} onDrop={() => dropTrack(track.id)}><div className="track-main" role="button" tabIndex={0} onClick={() => onTrackSelect(track)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onTrackSelect(track); } }}><span className="track-number">{String(index + 1).padStart(2, "0")}</span><span className="drag-handle" aria-hidden="true">::</span>{editingTrackId === track.id ? <input className="track-title-editor" autoFocus value={editingTitle} onChange={(event) => setEditingTitle(event.target.value)} onClick={(event) => event.stopPropagation()} onBlur={() => finishEditing(track)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { setEditingTrackId(""); setEditingTitle(track.title); } }} /> : <span className="track-name"><strong>{track.title}</strong></span>}</div><span className="track-duration">{track.duration}</span><div className="track-actions"><span className="track-menu-wrap"><button type="button" className={`track-action track-menu-trigger ${trackMenuId === track.id ? "is-active" : ""}`} onClick={(event) => { event.stopPropagation(); setTrackMenuId(trackMenuId === track.id ? "" : track.id); }} aria-label={`Open actions for ${track.title}`} aria-expanded={trackMenuId === track.id}><DotsThree size={17} /></button>{trackMenuId === track.id && <TrackMenu track={track} index={index} trackCount={project.tracks.length} onMove={(direction) => { setTrackMenuId(""); moveTrack(index, direction); }} onRename={() => { setTrackMenuId(""); startEditing(track); }} onNotes={() => { setTrackMenuId(""); onNoteTargetChange(noteTargetId === track.id ? null : track.id); }} onRemove={() => { setTrackMenuId(""); onRemoveTrack(track); }} onClose={() => setTrackMenuId("")} />}</span></div></div>)}</div></div>{notesOpen && <aside className="notes-panel glass"><div className="notes-heading"><div><h2>Notes</h2><span className="notes-context">{noteLabel}</span></div><span className={`notes-state is-${noteStatus}`} aria-live="polite">{noteStatus === "saving" ? "Saving" : noteStatus === "error" ? "Couldn’t save" : <><Check size={12} />Saved</>}</span></div><textarea aria-label={`${noteLabel} notes`} value={noteText} onChange={(event) => onNoteChange(event.target.value)} disabled={!nativeAvailable} /></aside>}</div>
      </div>
    </div>
  </section>;
}

function TrackMenu({ track, index, trackCount, onMove, onRename, onNotes, onRemove, onClose }) {
  const menuRef = useRef(null);
  useEffect(() => {
    function handlePointerDown(event) {
      if (!menuRef.current?.parentElement?.contains(event.target)) onClose();
    }
    function handleKeyDown(event) {
      if (event.key === "Escape") onClose();
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    menuRef.current?.querySelector("button")?.focus();
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  return <div ref={menuRef} className="track-menu glass" data-popover role="menu" aria-label={`Actions for ${track.title}`}>
    <span className="eyebrow">Track actions</span>
    <button type="button" role="menuitem" onClick={() => onMove(-1)} disabled={index === 0}><CaretLeft size={14} />Move earlier</button>
    <button type="button" role="menuitem" onClick={() => onMove(1)} disabled={index === trackCount - 1}><CaretRight size={14} />Move later</button>
    <button type="button" role="menuitem" onClick={onRename}><NotePencil size={14} />Rename track</button>
    <button type="button" role="menuitem" onClick={onNotes}><NotePencil size={14} />{track.note?.text ? "Edit notes" : "Add notes"}</button>
    <button type="button" className="track-menu-danger" role="menuitem" onClick={onRemove}><Trash size={14} />Remove track</button>
  </div>;
}

function WaveformProgress({ track, progress, durationMs, onChange }) {
  const seed = waveformSeed(track);
  const fallbackBars = useMemo(() => createWaveform(seed, 72), [seed]);
  const [bars, setBars] = useState(() => readCachedWaveform(track) ?? fallbackBars);

  useEffect(() => {
    let cancelled = false;
    const cached = readCachedWaveform(track);
    setBars(cached ?? fallbackBars);
    if (cached) return undefined;
    if (!isTauri() || !track.managedFilePath) return undefined;
    cacheWaveform(track, convertFileSrc(track.managedFilePath), 72).then((nextBars) => {
      if (!cancelled && nextBars.length) setBars(nextBars);
    }).catch(() => {
      if (!cancelled) setBars(fallbackBars);
    });
    return () => { cancelled = true; };
  }, [fallbackBars, track]);

  const safeProgress = Math.max(0, Math.min(100, Number(progress) || 0));
  const renderBars = (layer) => bars.map((height, index) => <span key={`${layer}-${index}`} style={{ height: `${height}%` }} />);
  return <div className="waveform-progress" style={{ "--waveform-progress": `${safeProgress}%` }}>
    <div className="waveform-layer waveform-layer-muted" aria-hidden="true">{renderBars("muted")}</div>
    <div className="waveform-layer waveform-layer-active" aria-hidden="true">{renderBars("active")}</div>
    <span className="waveform-cursor" aria-hidden="true" />
    <input className="waveform-input" aria-label="Playback position" type="range" min="0" max="100" value={safeProgress} onChange={onChange} disabled={!durationMs} />
  </div>;
}

function Player({ project, track, status, playbackError, isPlaying, progress, elapsedMs, durationMs, volume, muted, volumeOpen, queueOpen, menuOpen, shuffleEnabled, repeatMode, onTogglePlay, onPrevious, onNext, onProgressChange, onVolumeChange, onToggleMute, onToggleVolume, onToggleQueue, onToggleMenu, onToggleShuffle, onToggleRepeat, onOpenProject, onShowTrack, onOpenNotes, onRevealFile, onShowInfo }) {
  const statusText = status === "loading" ? "Loading" : status === "error" ? "Unavailable" : project.title;
  const repeatLabel = repeatMode === "track" ? "Repeat track" : repeatMode === "project" ? "Repeat project" : "Repeat off";
  return <section className="player-shell glass" aria-label="Audio player">
    <div className="player-controls">
      <button type="button" onClick={onPrevious} aria-label="Previous track" title="Previous track"><SkipBack size={18} weight="fill" /></button>
      <button type="button" className="play-button" onClick={onTogglePlay} aria-label={isPlaying ? "Pause" : "Play"} aria-keyshortcuts="Space" title={`${isPlaying ? "Pause" : "Play"} (Space)`}>{isPlaying ? <Pause size={18} weight="fill" /> : <Play size={18} weight="fill" />}</button>
      <button type="button" onClick={onNext} aria-label="Next track" title="Next track"><SkipForward size={18} weight="fill" /></button>
    </div>
    <div className="player-track">
      <img src={project.artwork} alt="" />
      <span><strong>{track.title}</strong><small>{playbackError || statusText}</small></span>
      <span className="player-menu-wrap"><button className="player-more" type="button" onClick={onToggleMenu} aria-label="Open player menu" aria-expanded={menuOpen} title="Track options"><DotsThree size={18} /></button>{menuOpen && <PlayerMenu track={track} onOpenProject={onOpenProject} onShowTrack={onShowTrack} onOpenNotes={onOpenNotes} onRevealFile={onRevealFile} onShowInfo={onShowInfo} onClose={onToggleMenu} />}</span>
    </div>
    <div className="player-progress">
      <div className="player-progress-top"><span>{formatTime(elapsedMs)}</span><span>{formatTime(durationMs)}</span></div>
      <WaveformProgress track={track} progress={progress} durationMs={durationMs} onChange={onProgressChange} />
    </div>
    <div className="player-actions">
      <button className={`player-action-button ${shuffleEnabled ? "is-active" : ""}`} type="button" onClick={onToggleShuffle} aria-label={shuffleEnabled ? "Turn shuffle off" : "Turn shuffle on"} aria-pressed={shuffleEnabled} title={shuffleEnabled ? "Shuffle on" : "Shuffle off"}><Shuffle size={18} /></button>
      <button className={`player-action-button repeat-button ${repeatMode !== "off" ? "is-active" : ""}`} type="button" onClick={onToggleRepeat} aria-label={repeatLabel} aria-pressed={repeatMode !== "off"} title={repeatLabel}>{repeatMode === "track" ? <RepeatOnce size={18} /> : <Repeat size={18} />}</button>
      <button className={`queue-button ${queueOpen ? "is-active" : ""}`} type="button" onClick={onToggleQueue} aria-label="Open queue" aria-expanded={queueOpen} title="Queue"><ListBullets size={18} /></button>
      <div className={`volume-control ${volumeOpen ? "is-open" : ""}`}><button className="player-action-button volume-button" type="button" onClick={onToggleVolume} aria-label={volumeOpen ? "Close volume" : "Open volume"} aria-expanded={volumeOpen} title="Volume">{muted ? <SpeakerX size={18} /> : <SpeakerHigh size={18} />}</button>{volumeOpen && <VolumePopover volume={volume} muted={muted} onChange={onVolumeChange} onToggleMute={onToggleMute} onClose={onToggleVolume} />}</div>
    </div>
  </section>;
}

function VolumePopover({ volume, muted, onChange, onToggleMute, onClose }) {
  const popoverRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const focusable = () => Array.from(popoverRef.current?.querySelectorAll("input, button") ?? []).filter((element) => !element.disabled);
    const focusTimer = window.setTimeout(() => focusable()[0]?.focus(), 0);
    function handleKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const elements = focusable();
      if (!elements.length) return;
      if (event.shiftKey && document.activeElement === elements[0]) {
        event.preventDefault();
        elements[elements.length - 1].focus();
      } else if (!event.shiftKey && document.activeElement === elements[elements.length - 1]) {
        event.preventDefault();
        elements[0].focus();
      }
    }
    function handlePointerDown(event) {
      if (!popoverRef.current?.contains(event.target) && !event.target.closest?.(".volume-button")) onCloseRef.current();
    }
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown);
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  const volumeValue = muted ? 0 : Math.max(0, Math.min(100, Number(volume) || 0));
  return <div ref={popoverRef} className="volume-popover" role="dialog" aria-label="Volume control"><div className="volume-slider" style={{ "--volume-level": `${volumeValue}%` }}><span className="volume-slider-rail" aria-hidden="true" /><span className="volume-slider-fill" aria-hidden="true" /><span className="volume-slider-thumb" aria-hidden="true" /><input className="volume-slider-input" aria-label="Volume" type="range" min="0" max="100" value={volumeValue} onChange={onChange} /></div><button type="button" className="volume-mute" onClick={onToggleMute} aria-label={muted ? "Unmute" : "Mute"} title={muted ? "Unmute" : "Mute"}>{muted ? <SpeakerX size={20} /> : <SpeakerHigh size={20} />}</button></div>;
}

function DialogFrame({ titleId, onClose, children, className = "", dismissOnBackdrop = true }) {
  const dialogRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previous = document.activeElement;
    const focusable = () => Array.from(dialogRef.current?.querySelectorAll("button, input, textarea, select, [tabindex]:not([tabindex='-1'])") ?? []).filter((element) => !element.disabled && element.getAttribute("aria-hidden") !== "true");
    const focusTimer = window.setTimeout(() => {
      if (!dialogRef.current?.contains(document.activeElement)) focusable()[0]?.focus();
    }, 0);
    function handleKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const elements = focusable();
      if (!elements.length) return;
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleKeyDown);
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  return <div className="modal-backdrop" role="presentation" onMouseDown={(event) => { if (dismissOnBackdrop && event.target === event.currentTarget) onClose(); }}><section ref={dialogRef} className={`import-prompt glass modal-form ${className}`} role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={(event) => event.stopPropagation()}>{children}</section></div>;
}

function ProfilePopover({ nativeAvailable, storageInfo, storageError, preferences, importProgress, onTogglePreference, onRevealFolder, onExportBackup, onRestoreBackup, onRetryStorage, onDiagnostics, onClose }) {
  const popoverRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const focusable = () => Array.from(popoverRef.current?.querySelectorAll("button, input") ?? []).filter((element) => !element.disabled);
    const focusTimer = window.setTimeout(() => focusable()[0]?.focus(), 0);
    function handleKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const elements = focusable();
      if (!elements.length) return;
      if (event.shiftKey && document.activeElement === elements[0]) {
        event.preventDefault();
        elements[elements.length - 1].focus();
      } else if (!event.shiftKey && document.activeElement === elements[elements.length - 1]) {
        event.preventDefault();
        elements[0].focus();
      }
    }
    function handlePointerDown(event) {
      if (!popoverRef.current?.contains(event.target) && !event.target.closest?.(".profile-button")) onCloseRef.current();
    }
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown);
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  const nativeHint = "Available in the native OPAL app.";
  return <div ref={popoverRef} className="profile-popover glass" data-popover role="dialog" aria-label="OPAL settings"><div className="profile-heading"><div><span className="eyebrow">OPAL</span><h2>Settings</h2></div><button type="button" className="popover-close" onClick={onClose} aria-label="Close settings"><X size={15} /></button></div><div className="storage-card"><div className="storage-card-heading"><Database size={16} /><span>Library storage</span><strong>{storageInfo ? formatBytes(storageInfo.totalBytes) : "—"}</strong></div>{storageError ? <div className="popover-error" role="alert"><span>Couldn’t load storage details.</span><button type="button" onClick={onRetryStorage}>Retry</button></div> : <><p>{storageInfo ? `${storageInfo.projectCount} projects · ${storageInfo.trackCount} tracks` : nativeAvailable ? "Loading storage details…" : "Storage details unavailable in preview."}</p><code>{storageInfo?.folderPath ?? "Open the native app to view the library folder."}</code></>}</div><div className="popover-actions"><button type="button" onClick={onRevealFolder} disabled={!nativeAvailable} title={nativeAvailable ? "Reveal the OPAL library folder" : nativeHint}><FolderOpen size={15} />Reveal library folder</button><button type="button" onClick={onExportBackup} disabled={!nativeAvailable} title={nativeAvailable ? "Export a complete OPAL backup" : nativeHint}><Export size={15} />Export library backup</button><button type="button" onClick={onRestoreBackup} disabled={!nativeAvailable} title={nativeAvailable ? "Restore an OPAL backup" : nativeHint}><ArrowSquareOut size={15} />Restore backup</button></div>{importProgress?.status === "processing" && <div className="profile-import-status"><CircleNotch size={14} className="spin" />Importing {importProgress.current ?? 0}/{importProgress.total ?? 0}</div>}<div className="preference-section"><span className="eyebrow">Appearance</span><label><span><TextAa size={15} />Larger type</span><input type="checkbox" checked={preferences.largeType} onChange={() => onTogglePreference("largeType")} /></label><label><span><SlidersHorizontal size={15} />Reduce motion</span><input type="checkbox" checked={preferences.reduceMotion} onChange={() => onTogglePreference("reduceMotion")} /></label><label><span><Gear size={15} />Softer glass</span><input type="checkbox" checked={preferences.softerGlass} onChange={() => onTogglePreference("softerGlass")} /></label></div><div className="popover-footer"><span>OPAL {APP_VERSION}</span><button type="button" onClick={onDiagnostics} disabled={!nativeAvailable} title={nativeAvailable ? "Open diagnostics" : nativeHint}><Info size={14} />Diagnostics</button></div></div>;
}

function RecoveryView({ onRevealFolder, onRestore, onRetry }) {
  return <section className="recovery-screen view-stack"><div className="recovery-card glass"><WarningCircle size={30} /><span className="eyebrow">Local library</span><h1>Recovery needed</h1><p>OPAL could not safely open the library database. Your managed files were left in place.</p><div className="recovery-actions"><button className="button button-primary" type="button" onClick={onRestore}>Restore backup</button><button className="button button-ghost" type="button" onClick={onRetry}>Try again</button><button className="text-action" type="button" onClick={onRevealFolder}>Reveal library folder <FolderOpen size={14} /></button></div></div></section>;
}

function PlayerMenu({ track, onOpenProject, onShowTrack, onOpenNotes, onRevealFile, onShowInfo, onClose }) {
  const menuRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const focusable = () => Array.from(menuRef.current?.querySelectorAll("button") ?? []).filter((element) => !element.disabled);
    const focusTimer = window.setTimeout(() => focusable()[0]?.focus(), 0);
    function handleKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const elements = focusable();
      if (!elements.length) return;
      if (event.shiftKey && document.activeElement === elements[0]) {
        event.preventDefault();
        elements[elements.length - 1].focus();
      } else if (!event.shiftKey && document.activeElement === elements[elements.length - 1]) {
        event.preventDefault();
        elements[0].focus();
      }
    }
    function handlePointerDown(event) {
      if (!menuRef.current?.contains(event.target) && !event.target.closest?.(".player-more")) onCloseRef.current();
    }
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown);
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  const run = (action) => {
    onClose();
    action();
  };
  return <div ref={menuRef} className="player-menu glass" data-popover role="menu" aria-label={`Actions for ${track.title}`}><span className="eyebrow">Current track</span><button type="button" role="menuitem" onClick={() => run(onOpenProject)}><FolderOpen size={15} />Open project</button><button type="button" role="menuitem" onClick={() => run(onShowTrack)}><ListBullets size={15} />Show in project</button><button type="button" role="menuitem" onClick={() => run(onOpenNotes)}><NotePencil size={15} />Open track notes</button><button type="button" role="menuitem" onClick={() => run(onRevealFile)} disabled={!track.managedFilePath} title={track.managedFilePath ? "Reveal the managed audio file" : "The managed audio file is missing"}><ArrowSquareOut size={15} />Reveal managed file</button><button type="button" role="menuitem" onClick={() => run(onShowInfo)}><Info size={15} />Track information</button></div>;
}

function TrackInfoDialog({ project, track, onClose }) {
  return <DialogFrame titleId="track-info-title" onClose={onClose} className="info-dialog"><button className="modal-close" type="button" onClick={onClose} aria-label="Close track information"><X size={18} /></button><span className="eyebrow">Track</span><h2 id="track-info-title">{track.title}</h2><p className="dialog-subtitle">{project.title}</p><dl className="info-list"><div><dt>Format</dt><dd>{track.format || "Unknown"}</dd></div><div><dt>Duration</dt><dd>{track.duration}</dd></div><div><dt>Managed audio</dt><dd>{track.managedFilePath ? "Available" : "Missing"}</dd></div><div><dt>Notes</dt><dd>{track.note?.text ? "Has notes" : "Empty"}</dd></div></dl><button className="button button-primary modal-cta" type="button" onClick={onClose}>Done</button></DialogFrame>;
}

function DiagnosticsDialog({ diagnostics, onClose }) {
  return <DialogFrame titleId="diagnostics-title" onClose={onClose} className="info-dialog"><button className="modal-close" type="button" onClick={onClose} aria-label="Close diagnostics"><X size={18} /></button><span className="eyebrow">OPAL {APP_VERSION}</span><h2 id="diagnostics-title">Diagnostics</h2><dl className="info-list"><div><dt>Database</dt><dd>{diagnostics?.databaseStatus ?? "Unavailable"}</dd></div><div><dt>Integrity</dt><dd>{diagnostics?.integrity ?? "Unavailable"}</dd></div><div><dt>Projects</dt><dd>{diagnostics?.projectCount ?? 0}</dd></div><div><dt>Tracks</dt><dd>{diagnostics?.trackCount ?? 0}</dd></div><div><dt>Pending cleanup</dt><dd>{diagnostics?.pendingCleanupCount ?? 0}</dd></div><div><dt>Active imports</dt><dd>{diagnostics?.activeImportCount ?? 0}</dd></div></dl><button className="button button-primary modal-cta" type="button" onClick={onClose}>Done</button></DialogFrame>;
}

function ConfirmDialog({ title, message, confirmLabel, destructive, busy, onClose, onConfirm }) {
  return <DialogFrame titleId="confirm-title" onClose={onClose} dismissOnBackdrop={!busy} className="confirm-dialog"><button className="modal-close" type="button" onClick={onClose} disabled={busy} aria-label="Close confirmation"><X size={18} /></button><span className="eyebrow">Please confirm</span><h2 id="confirm-title">{title}</h2><p className="dialog-subtitle">{message}</p><div className="confirm-actions"><button className="button button-ghost" type="button" onClick={onClose} disabled={busy}>Cancel</button><button className={`button ${destructive ? "button-danger" : "button-primary"}`} type="button" onClick={onConfirm} disabled={busy}>{busy ? "Working…" : confirmLabel}</button></div></DialogFrame>;
}

function QueuePopover({ project, currentIndex, onSelect, onClose }) {
  const popoverRef = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement;
    const focusable = () => Array.from(popoverRef.current?.querySelectorAll("button") ?? []).filter((element) => !element.disabled);
    const focusTimer = window.setTimeout(() => focusable()[0]?.focus(), 0);
    function handleKeyDown(event) {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const elements = focusable();
      if (!elements.length) return;
      if (event.shiftKey && document.activeElement === elements[0]) {
        event.preventDefault();
        elements[elements.length - 1].focus();
      } else if (!event.shiftKey && document.activeElement === elements[elements.length - 1]) {
        event.preventDefault();
        elements[0].focus();
      }
    }
    function handlePointerDown(event) {
      if (!popoverRef.current?.contains(event.target) && !event.target.closest?.(".queue-button")) onCloseRef.current();
    }
    document.addEventListener("keydown", handleKeyDown);
    document.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener("keydown", handleKeyDown);
      document.removeEventListener("pointerdown", handlePointerDown);
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);
  const nextTracks = project.tracks.slice(Math.max(0, currentIndex + 1), currentIndex + 4);
  return <div ref={popoverRef} className="queue-popover glass" data-popover role="dialog" aria-label="Playback queue"><div className="queue-heading"><span>Queue</span><button type="button" onClick={onClose}>Close</button></div>{nextTracks.length ? nextTracks.map((track, index) => <button className="queue-row" type="button" key={track.id} onClick={() => onSelect(track, currentIndex + index + 1)}><span>{String(index + 1).padStart(2, "0")}</span><strong>{track.title}</strong><small>{track.duration}</small></button>) : <div className="queue-empty">No more tracks</div>}</div>;
}

function CreateProjectPrompt({ onClose, onCreate }) {
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  return <DialogFrame titleId="create-title" onClose={onClose}><button className="modal-close" type="button" onClick={onClose} aria-label="Close create project prompt"><X size={18} /></button><h2 id="create-title">New project</h2><form onSubmit={(event) => { event.preventDefault(); onCreate(title, description); }}><div className="modal-field"><label htmlFor="project-title">Title</label><input id="project-title" autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Project title" required /></div><div className="modal-field"><label htmlFor="project-description">Description <span>Optional</span></label><textarea id="project-description" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Description" /></div><button className="button button-primary modal-cta" type="submit">Create <ArrowUpRight size={14} /></button></form></DialogFrame>;
}

function ProjectEditorPrompt({ project, onClose, onSave }) {
  const [title, setTitle] = useState(project.title);
  const [description, setDescription] = useState(project.description);
  return <DialogFrame titleId="edit-title" onClose={onClose}><button className="modal-close" type="button" onClick={onClose} aria-label="Close project editor"><X size={18} /></button><h2 id="edit-title">Edit project</h2><form onSubmit={(event) => { event.preventDefault(); onSave(title, description); }}><div className="modal-field"><label htmlFor="edit-project-title">Title</label><input id="edit-project-title" autoFocus value={title} onChange={(event) => setTitle(event.target.value)} required /></div><div className="modal-field"><label htmlFor="edit-project-description">Description</label><textarea id="edit-project-description" value={description} onChange={(event) => setDescription(event.target.value)} /></div><button className="button button-primary modal-cta" type="submit">Save <CloudCheck size={14} /></button></form></DialogFrame>;
}

function ImportPrompt({ project, progress, duplicatePaths, onClose, onChooseFiles, onRetryImport, onImportDuplicates, onSkipDuplicates }) {
  const results = progress?.results ?? [];
  const total = progress?.total ?? 0;
  const current = Math.min(progress?.current ?? 0, total);
  const progressPercent = total ? (current / total) * 100 : 0;
  return <DialogFrame titleId="import-title" onClose={onClose} dismissOnBackdrop={false}><button className="modal-close" type="button" onClick={onClose} aria-label="Close import prompt"><X size={18} /></button><h2 id="import-title">Import audio</h2><p>Files are copied into OPAL storage. Originals stay untouched.</p><button className="drop-zone" type="button" onClick={onChooseFiles}><FileAudio size={26} weight="thin" /><strong>Choose audio</strong><span>WAV · MP3 · FLAC · AIFF · M4A</span></button>{progress && <div className="import-summary"><div className="import-summary-top"><span>{progress.status === "processing" ? "Importing" : progress.status === "error" ? "Import error" : progress.status === "duplicates" ? "Duplicates" : "Complete"}</span><strong>{current}/{total}</strong></div><div className="import-progress-bar"><span style={{ width: `${progressPercent}%` }} /></div>{progress.message && <small>{progress.message}</small>}</div>}{results.length > 0 && <div className="import-results">{results.map((result) => <div className={`import-result is-${result.status}`} key={`${result.path}-${result.status}`}><span><strong>{result.fileName}</strong><small>{result.message}</small></span><em>{result.status}</em></div>)}</div>}{progress?.status === "error" && <div className="import-actions"><button className="button button-primary" type="button" onClick={onRetryImport}>Retry import</button></div>}{duplicatePaths.length > 0 && <div className="import-actions"><button className="button button-primary" type="button" onClick={onImportDuplicates}>Import duplicates</button><button className="button button-ghost" type="button" onClick={onSkipDuplicates}>Skip duplicates</button></div>}</DialogFrame>;
}

export { App };
