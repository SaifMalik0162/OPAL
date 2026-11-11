import React, { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
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
  Broadcast,
  CaretDown,
  CaretLeft,
  CaretRight,
  Check,
  CircleNotch,
  CloudCheck,
  Copy,
  Database,
  DotsThree,
  Export,
  FileAudio,
  FolderOpen,
  Gear,
  Info,
  ImageSquare,
  LockKey,
  ListBullets,
  MagnifyingGlass,
  NotePencil,
  Pause,
  Play,
  Plus,
  PaperPlaneTilt,
  Queue,
  Repeat,
  RepeatOnce,
  Shuffle,
  SlidersHorizontal,
  SkipBack,
  SkipForward,
  SpeakerHigh,
  SpeakerX,
  ShareNetwork,
  ShieldCheck,
  TextAa,
  Trash,
  WarningCircle,
  Waveform,
  X,
  Eye,
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
    tracks: (project.tracks ?? []).map((track) => ({
      ...track,
      groupId: track.groupId ?? track.id,
      sourceTitle: track.sourceTitle ?? track.title,
      versionName: track.versionName ?? "Original",
      versionPosition: track.versionPosition ?? 0,
      isCurrent: track.isCurrent ?? true,
      versionCount: track.versionCount ?? 1,
      moments: (track.moments ?? []).map((moment) => ({
        ...moment,
        timeMs: moment.timeMs ?? 0,
        state: moment.state ?? "question",
        text: moment.text ?? "",
        isResolved: moment.isResolved ?? false,
      })),
    })),
    transitions: (project.transitions ?? []).map((transition) => ({
      ...transition,
      gapMs: transition.gapMs ?? 0,
      note: transition.note ?? "",
    })),
  };
}

function hydrateCapsule(capsule) {
  return {
    ...capsule,
    artwork: isTauri() && capsule.artworkPath ? convertFileSrc(capsule.artworkPath) : FALLBACK_ARTWORK,
    tracks: (capsule.tracks ?? []).map((track) => ({
      ...track,
      groupId: track.groupId ?? track.id,
      versionName: track.versionName ?? "Original",
      moments: track.moments ?? [],
    })),
    projectNote: capsule.projectNote ?? null,
    transitions: capsule.transitions ?? [],
    responses: capsule.responses ?? [],
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

const MOMENT_STATES = ["keep", "change", "question", "idea"];
const MOMENT_STATE_LABELS = { keep: "Keep", change: "Change", question: "Question", idea: "Idea" };

function momentStateLabel(state) {
  return MOMENT_STATE_LABELS[state] ?? "Question";
}

function groupTracks(project) {
  const groups = new Map();
  (project?.tracks ?? []).forEach((track) => {
    const groupId = track.groupId ?? track.id;
    const group = groups.get(groupId) ?? {
      id: groupId,
      title: track.title,
      position: track.position ?? 0,
      versions: [],
    };
    group.versions.push(track);
    groups.set(groupId, group);
  });
  return Array.from(groups.values())
    .sort((left, right) => left.position - right.position)
    .map((group) => {
      const versions = [...group.versions].sort((left, right) => (left.versionPosition ?? 0) - (right.versionPosition ?? 0));
      return { ...group, versions, current: versions.find((version) => version.isCurrent) ?? versions[0] ?? null };
    });
}

function currentVersions(project) {
  return groupTracks(project).map((group) => group.current).filter(Boolean);
}

function trackGroupId(track) {
  return track?.groupId ?? track?.id ?? "";
}

function sequenceTransition(project, fromTrack, toTrack) {
  const fromGroupId = trackGroupId(fromTrack);
  const toGroupId = trackGroupId(toTrack);
  return project?.transitions?.find((transition) => transition.fromGroupId === fromGroupId && transition.toGroupId === toGroupId) ?? null;
}

function formatGap(gapMs) {
  const seconds = Math.round(Math.max(0, Number(gapMs) || 0) / 1000);
  return seconds ? `+${seconds}s` : "Cut";
}

function playbackTracks(project, preferredTrackId = "") {
  const tracks = currentVersions(project);
  const preferredTrack = project?.tracks.find((track) => track.id === preferredTrackId);
  if (!preferredTrack) return tracks;
  const groupId = preferredTrack.groupId ?? preferredTrack.id;
  const currentIndex = tracks.findIndex((track) => (track.groupId ?? track.id) === groupId);
  if (currentIndex >= 0) tracks[currentIndex] = preferredTrack;
  else tracks.push(preferredTrack);
  return tracks;
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
  const [selectedMomentId, setSelectedMomentId] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importTargetId, setImportTargetId] = useState("");
  const [importTargetGroupId, setImportTargetGroupId] = useState("");
  const [importProgress, setImportProgress] = useState(null);
  const [duplicatePaths, setDuplicatePaths] = useState([]);
  const [importActive, setImportActive] = useState(false);
  const [capsule, setCapsule] = useState(null);
  const [capsuleCreateOpen, setCapsuleCreateOpen] = useState(false);
  const [capsuleResponseOpen, setCapsuleResponseOpen] = useState(false);
  const audioRef = useRef(null);
  const playbackRef = useRef({ requestId: 0, project: null, projectId: "", trackId: "", queue: [], index: -1, sequenceMode: false, gapTimer: null });
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
  const capsulePasswordRef = useRef("");

  if (!noteStoreRef.current) noteStoreRef.current = createNoteStore(window.localStorage);

  const selectedProject = projects.find((project) => project.id === selectedId) ?? null;
  const playingProject = projects.find((project) => project.id === playingProjectId) ?? null;
  const playingTrack = playingProject?.tracks.find((track) => track.id === playingTrackId) ?? null;
  const displayProject = playingProject ?? selectedProject;
  const displayTrack = playingTrack ?? currentVersions(selectedProject)[0] ?? null;
  const displayTrackQueue = displayProject ? currentVersions(displayProject) : [];
  const displayTrackIndex = displayTrackQueue.findIndex((track) => track.id === displayTrack?.id);
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
    return sortedProjects.filter((project) => project.title.toLowerCase().includes(normalizedQuery) || project.tracks.some((track) => [track.title, track.versionName, track.sourceTitle].some((value) => value?.toLowerCase().includes(normalizedQuery))));
  }, [query, sortedProjects]);
  const trackMatches = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return new Map(sortedProjects.map((project) => [project.id, normalizedQuery ? project.tracks.find((track) => [track.title, track.versionName, track.sourceTitle].some((value) => value?.toLowerCase().includes(normalizedQuery))) : null]));
  }, [query, sortedProjects]);
  const importProject = projects.find((project) => project.id === importTargetId) ?? selectedProject;
  const importTargetGroup = groupTracks(importProject).find((group) => group.id === importTargetGroupId) ?? null;
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
        setImportTargetGroupId("");
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

  function clearPlaybackGapTimer() {
    if (playbackRef.current.gapTimer) window.clearTimeout(playbackRef.current.gapTimer);
    playbackRef.current = { ...playbackRef.current, gapTimer: null };
  }

  function startPlayback(project, track, index = -1, queueOverride = null, startAtMs = 0, autoplay = true, sequenceMode = playbackRef.current.sequenceMode) {
    const audio = audioRef.current;
    clearPlaybackGapTimer();
    const requestId = playbackRef.current.requestId + 1;
    const baseQueue = playbackTracks(project, track.id);
    const queue = queueOverride ?? (shuffleRef.current ? shuffleQueue(baseQueue, track.id, project.id) : baseQueue);
    const queueIndex = index >= 0 ? index : queue.findIndex((item) => item.id === track.id);
    playbackRef.current = { requestId, project, projectId: project.id, trackId: track.id, queue, index: queueIndex, sequenceMode, gapTimer: null };
    setPlayingProjectId(project.id);
    setPlayingTrackId(track.id);
    setElapsedMs(startAtMs);
    setDurationMs(track.durationMs || 0);
    setPlaybackError("");
    setPlaybackState(autoplay ? "loading" : "paused");
    if (!audio) return;
    audio.pause();
    audio.onloadedmetadata = () => {
      if (!isCurrentPlaybackRequest(requestId, playbackRef.current.requestId)) return;
      if (Number.isFinite(audio.duration)) {
        const nextDuration = Math.round(audio.duration * 1000);
        setDurationMs(nextDuration);
        if (startAtMs > 0) {
          const nextElapsed = Math.min(startAtMs, nextDuration);
          audio.currentTime = nextElapsed / 1000;
          setElapsedMs(nextElapsed);
        }
      }
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
      if (nextTrack && nextIndex !== null) {
        const currentTrack = playbackRef.current.project?.tracks.find((item) => item.id === playbackRef.current.trackId) ?? track;
        const transition = playbackRef.current.sequenceMode ? sequenceTransition(playbackRef.current.project, currentTrack, nextTrack) : null;
        const gapMs = transition?.gapMs ?? 0;
        if (gapMs > 0) {
          setPlaybackState("transition");
          const requestIdAtEnd = playbackRef.current.requestId;
          const gapTimer = window.setTimeout(() => {
            if (!isCurrentPlaybackRequest(requestIdAtEnd, playbackRef.current.requestId)) return;
            const active = playbackRef.current;
            const activeNextIndex = repeatQueueIndex(active.index, active.queue.length, repeatRef.current);
            const activeNextTrack = activeNextIndex === null ? null : active.queue[activeNextIndex];
            if (activeNextTrack && activeNextIndex !== null) startPlayback(active.project, activeNextTrack, activeNextIndex, active.queue, 0, true, true);
          }, gapMs);
          playbackRef.current = { ...playbackRef.current, gapTimer };
        } else {
          startPlayback(playbackRef.current.project, nextTrack, nextIndex, playbackRef.current.queue, 0, true, playbackRef.current.sequenceMode);
        }
      } else {
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
    if (!autoplay) return;
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
    clearPlaybackGapTimer();
    playbackRef.current = { ...playbackRef.current, requestId: playbackRef.current.requestId + 1, project: null, projectId: "", trackId: "", queue: [], index: -1, sequenceMode: false, gapTimer: null };
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

  function applyProjectUpdate(projectData) {
    const updated = hydrateProject(projectData);
    setProjects((current) => current.map((project) => project.id === updated.id ? updated : project));
    updatePlayingQueue(updated);
    return updated;
  }

  async function createMoment(project, track, timeMs) {
    if (!isTauri()) {
      setError("Open the native OPAL app to save listening moments.");
      return;
    }
    try {
      const updated = applyProjectUpdate(await invoke("createMoment", {
        projectId: project.id,
        trackId: track.id,
        timeMs: Math.round(timeMs),
        state: "question",
        text: "",
      }));
      const createdTrack = updated.tracks.find((item) => item.id === track.id);
      const createdMoment = [...(createdTrack?.moments ?? [])].sort((left, right) => right.createdAt - left.createdAt)[0];
      if (createdMoment) setSelectedMomentId(createdMoment.id);
      setError("");
    } catch (momentError) {
      setError(String(momentError));
    }
  }

  async function updateMoment(project, moment, changes) {
    if (!isTauri()) {
      setError("Open the native OPAL app to edit listening moments.");
      return;
    }
    try {
      applyProjectUpdate(await invoke("updateMoment", {
        projectId: project.id,
        momentId: moment.id,
        timeMs: changes.timeMs ?? moment.timeMs,
        state: changes.state ?? moment.state,
        text: changes.text ?? moment.text,
        isResolved: changes.isResolved ?? moment.isResolved,
      }));
      setSelectedMomentId(moment.id);
      setError("");
    } catch (momentError) {
      setError(String(momentError));
    }
  }

  function selectMoment(project, track, moment) {
    setSelectedMomentId(moment.id);
    setNoteTargetId(track.id);
    if (project.id !== selectedId || activeView !== "project") {
      void openProject(project.id, track.id, track.id);
    } else {
      setFocusedTrackId(track.id);
    }
  }

  function jumpToMoment(project, track, moment) {
    selectMoment(project, track, moment);
    const current = playbackRef.current;
    const sameTrack = current.projectId === project.id && current.trackId === track.id;
    startPlayback(project, track, -1, sameTrack && current.queue.length ? current.queue : null, moment.timeMs, sameTrack ? playbackState === "playing" : true);
  }

  function jumpUnresolved(project, track, direction) {
    const moments = [...(track?.moments ?? [])].filter((moment) => !moment.isResolved).sort((left, right) => left.timeMs - right.timeMs);
    if (!moments.length) return;
    const currentIndex = moments.findIndex((moment) => moment.id === selectedMomentId);
    const nextIndex = currentIndex < 0 ? (direction > 0 ? 0 : moments.length - 1) : (currentIndex + direction + moments.length) % moments.length;
    jumpToMoment(project, track, moments[nextIndex]);
  }

  async function openSequenceRoom(project) {
    await flushNoteSave();
    setSelectedId(project.id);
    setActiveView("sequence");
  }

  async function leaveSequenceRoom() {
    await flushNoteSave();
    setActiveView("project");
  }

  async function openCapsuleBuilder(project) {
    await flushNoteSave();
    setSelectedId(project.id);
    setCapsuleCreateOpen(true);
  }

  async function createCapsule(project, options) {
    if (!isTauri()) {
      setError("Open the native OPAL app to create a private capsule.");
      return;
    }
    try {
      const created = hydrateCapsule(await invoke("createCapsule", {
        projectId: project.id,
        trackIds: options.trackIds,
        includeNotes: options.includeNotes,
        password: options.password || null,
        expiresAt: options.expiresAt || null,
        title: options.title,
        message: options.message,
      }));
      capsulePasswordRef.current = options.password || "";
      setCapsule(created);
      setCapsuleCreateOpen(false);
      setCapsuleResponseOpen(false);
      setActiveView("capsule");
      setNotice("Private capsule ready. Its responses will return to your decision trail.");
      setError("");
    } catch (capsuleError) {
      setError(String(capsuleError));
    }
  }

  async function leaveCapsuleView() {
    await flushNoteSave();
    setActiveView("project");
    setCapsuleResponseOpen(false);
  }

  function capsulePlaybackTracks(nextCapsule) {
    if (!selectedProject || !nextCapsule) return [];
    return nextCapsule.tracks.map((track) => selectedProject.tracks.find((item) => item.id === track.id) ?? track).filter(Boolean);
  }

  function playCapsuleTrack(nextCapsule, track, index = -1, startAtMs = 0) {
    const queue = capsulePlaybackTracks(nextCapsule);
    const actualTrack = queue.find((item) => item.id === track.id);
    const queueIndex = index >= 0 ? index : queue.findIndex((item) => item.id === track.id);
    if (actualTrack && queueIndex >= 0) startPlayback(selectedProject, actualTrack, queueIndex, queue, startAtMs, true, true);
  }

  function toggleCapsulePlayback(nextCapsule) {
    const current = playbackRef.current;
    if (current.projectId === nextCapsule.projectId && current.queue.length && nextCapsule.tracks.some((track) => track.id === current.trackId) && playbackState !== "ended" && playbackState !== "error") {
      playbackRef.current = { ...current, sequenceMode: true };
      togglePlayback();
      return;
    }
    const first = nextCapsule.tracks[0];
    if (first) playCapsuleTrack(nextCapsule, first, 0);
  }

  async function addCapsuleResponse(nextCapsule, track, timeMs, state, text) {
    if (!isTauri()) {
      setError("Open the native OPAL app to send a capsule response.");
      return;
    }
    try {
      const updated = hydrateCapsule(await invoke("addCapsuleResponse", {
        capsuleId: nextCapsule.id,
        trackId: track.id,
        timeMs: Math.round(timeMs),
        state,
        text,
        password: capsulePasswordRef.current || null,
      }));
      setCapsule(updated);
      await reloadProjects(nextCapsule.projectId);
      setCapsuleResponseOpen(false);
      setNotice("Response returned to the OPAL decision trail.");
      setError("");
    } catch (responseError) {
      setError(String(responseError));
    }
  }

  async function copyCapsuleReference(nextCapsule) {
    try {
      await navigator.clipboard.writeText(nextCapsule.shareReference);
      setNotice("Private capsule reference copied.");
    } catch {
      setError(`Copy this capsule reference: ${nextCapsule.shareReference}`);
    }
  }

  function playSequenceTrack(project, track, index = -1, startAtMs = 0) {
    const sequence = currentVersions(project);
    const sequenceIndex = index >= 0 ? index : sequence.findIndex((item) => item.id === track.id);
    startPlayback(project, track, sequenceIndex, sequence, startAtMs, true, true);
  }

  function toggleSequencePlayback(project) {
    const current = playbackRef.current;
    if (current.projectId === project.id && current.trackId && current.queue.length && playbackState !== "ended" && playbackState !== "error") {
      playbackRef.current = { ...current, sequenceMode: true };
      togglePlayback();
      return;
    }
    const sequence = currentVersions(project);
    const track = sequence.find((item) => item.id === current.trackId) ?? sequence[0];
    if (track) playSequenceTrack(project, track, sequence.findIndex((item) => item.id === track.id), current.projectId === project.id ? elapsedMs : 0);
  }

  function auditionTransition(project, fromTrack) {
    const sequence = currentVersions(project);
    const index = sequence.findIndex((track) => track.id === fromTrack.id);
    const leadInMs = Math.min(12_000, Math.max(0, fromTrack.durationMs || 0));
    playSequenceTrack(project, fromTrack, index, Math.max(0, (fromTrack.durationMs || 0) - leadInMs));
  }

  async function updateTransition(project, fromGroupId, toGroupId, gapMs, note) {
    if (!isTauri()) {
      setError("Open the native OPAL app to save sequence transitions.");
      return;
    }
    try {
      const updated = applyProjectUpdate(await invoke("updateTransition", {
        projectId: project.id,
        fromGroupId,
        toGroupId,
        gapMs: Math.round(gapMs),
        note,
      }));
      setError("");
      return updated;
    } catch (transitionError) {
      setError(String(transitionError));
      return null;
    }
  }

  function toggleShuffle() {
    setShuffleEnabled((enabled) => {
      const nextEnabled = !enabled;
      shuffleRef.current = nextEnabled;
      const current = playbackRef.current;
      if (current.project) {
        const baseQueue = playbackTracks(current.project, current.trackId);
        const queue = nextEnabled ? shuffleQueue(baseQueue, current.trackId, current.project.id) : baseQueue;
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

  function switchVersion(project, version) {
    const current = playbackRef.current;
    const activeTrack = current.project?.tracks.find((track) => track.id === current.trackId);
    const activeGroupId = activeTrack?.groupId ?? activeTrack?.id;
    const versionGroupId = version.groupId ?? version.id;
    const sameGroup = current.projectId === project.id && activeGroupId === versionGroupId;
    const queue = sameGroup && current.queue.length
      ? current.queue.map((track) => (track.groupId ?? track.id) === versionGroupId ? version : track)
      : (shuffleRef.current ? shuffleQueue(playbackTracks(project, version.id), version.id, project.id) : playbackTracks(project, version.id));
    const index = queue.findIndex((track) => track.id === version.id);
    const preservePosition = sameGroup && Number.isFinite(elapsedMs);
    const shouldAutoplay = sameGroup ? playbackState === "playing" : true;
    startPlayback(project, version, index, queue, preservePosition ? elapsedMs : 0, shouldAutoplay, current.sequenceMode);
  }

  function togglePlayback() {
    if (!displayProject || !displayTrack) return;
    if (playbackState === "transition") {
      playNext();
      return;
    }
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
    if (nextIndex !== null && current.queue[nextIndex]) startPlayback(current.project, current.queue[nextIndex], nextIndex, current.queue, 0, true, current.sequenceMode);
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
    } else if (current.project && previousIndex !== null) startPlayback(current.project, current.queue[previousIndex], previousIndex, current.queue, 0, true, current.sequenceMode);
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

  async function reorderTrackGroups(groupIds) {
    if (!selectedProject || !isTauri()) {
      setError("Open the native OPAL app to edit the local library.");
      return;
    }
    try {
      const updated = hydrateProject(await invoke("reorderTrackGroups", { projectId: selectedProject.id, groupIds }));
      setProjects((current) => current.map((project) => project.id === updated.id ? updated : project));
      updatePlayingQueue(updated);
      setError("");
    } catch (reorderError) {
      setError(String(reorderError));
    }
  }

  async function reorderTrackVersions(_group, versionIds) {
    if (!selectedProject || !isTauri()) {
      setError("Open the native OPAL app to edit the local library.");
      return;
    }
    try {
      const updated = hydrateProject(await invoke("reorderTrackVersions", { projectId: selectedProject.id, trackIds: versionIds }));
      setProjects((current) => current.map((project) => project.id === updated.id ? updated : project));
      updatePlayingQueue(updated);
      setError("");
    } catch (reorderError) {
      setError(String(reorderError));
    }
  }

  async function renameVersion(trackId, versionName) {
    if (!selectedProject || !isTauri()) {
      setError("Open the native OPAL app to edit the local library.");
      return;
    }
    try {
      const updated = hydrateProject(await invoke("renameTrackVersion", { projectId: selectedProject.id, trackId, versionName }));
      setProjects((current) => current.map((project) => project.id === updated.id ? updated : project));
      updatePlayingQueue(updated);
      setError("");
    } catch (renameError) {
      setError(String(renameError));
    }
  }

  async function promoteVersion(track) {
    if (!selectedProject || !isTauri()) {
      setError("Open the native OPAL app to edit the local library.");
      return;
    }
    try {
      const updated = hydrateProject(await invoke("promoteTrackVersion", { projectId: selectedProject.id, trackId: track.id }));
      setProjects((current) => current.map((project) => project.id === updated.id ? updated : project));
      updatePlayingQueue(updated);
      setError("");
    } catch (promoteError) {
      setError(String(promoteError));
    }
  }

  async function removeVersion(project, version, group) {
    if (!isTauri()) {
      setError("Open the native OPAL app to edit the local library.");
      return;
    }
    if (group.versions.length <= 1) {
      setError("A track must keep one version.");
      return;
    }
    const wasPlaying = playingProjectId === project.id && playingTrackId === version.id;
    setConfirmState({
      title: "Remove version",
      message: `Remove “${version.versionName}” from “${group.title}”? The OPAL-managed copy will be deleted. Your original file stays untouched.`,
      confirmLabel: "Remove version",
      destructive: true,
      onConfirm: async () => {
        try {
          if (wasPlaying) stopPlayback();
          const updated = hydrateProject(await invoke("deleteTrackVersion", { projectId: project.id, trackId: version.id }));
          setProjects((current) => current.map((item) => item.id === updated.id ? updated : item));
          if (!wasPlaying) updatePlayingQueue(updated);
          noteStoreRef.current.remove(`${project.id}:${version.id}`);
          if (noteTargetId === version.id) setNoteTargetId(null);
          setError("");
        } catch (removeError) {
          setError(String(removeError));
        }
      },
    });
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

  async function exportProjectToPhone(projectId = selectedProject?.id) {
    if (!projectId || !isTauri()) {
      setError("Open the native OPAL app and a project to export a phone package.");
      return;
    }
    try {
      const preview = await invoke("previewProjectPackage", { projectId });
      const message = `Send “${preview.projectTitle}” to your iPhone?\n\n${preview.songCount} songs · ${preview.mixCount} mixes · ${preview.momentCount} review moments\n${formatBytes(preview.assetBytes)} of audio and artwork\n\nThe package is stored as a single file and can be moved through AirDrop, Files, or another file provider.`;
      if (!window.confirm(message)) return;
      const project = projects.find((item) => item.id === projectId);
      const fileName = `${(project?.title || "OPAL Project").replace(/[\\/:*?"<>|]+/g, "-")}.opalproject`;
      const destination = await save({
        title: "Send OPAL project to iPhone",
        defaultPath: fileName,
        filters: [{ name: "OPAL Project", extensions: ["opalproject"] }],
      });
      if (!destination) return;
      const packagePath = await invoke("exportProjectPackage", { projectId, destination });
      setNotice(`Project package ready · ${packagePath}`);
      setError("");
    } catch (exportError) {
      setError(String(exportError));
    }
  }

  async function importPhoneReview(projectId = selectedProject?.id) {
    if (!isTauri()) {
      setError("Open the native OPAL app to import a phone review.");
      return;
    }
    try {
      const sourcePath = await open({ multiple: false, filters: [{ name: "OPAL Review", extensions: ["opalreview"] }] });
      if (typeof sourcePath !== "string") return;
      const preview = await invoke("previewMobileReview", { sourcePath });
      if (projectId && preview.projectId !== projectId) {
        setError(`This phone review belongs to “${preview.projectTitle}”, not the project currently open.`);
        return;
      }
      if (!preview.newMoments) {
        setNotice(`All ${preview.alreadyReceived} phone review moments for “${preview.projectTitle}” are already here.`);
        return;
      }
      const confirmed = window.confirm(`Import ${preview.newMoments} new ${preview.newMoments === 1 ? "review moment" : "review moments"} into “${preview.projectTitle}”?${preview.alreadyReceived ? `\n\n${preview.alreadyReceived} previously imported moments will be skipped.` : ""}`);
      if (!confirmed) return;
      const imported = await invoke("importMobileReview", { sourcePath });
      await reloadProjects(selectedProject?.id ?? projectId ?? "");
      setNotice(`Imported ${imported.newMoments} review moments into “${imported.projectTitle}”.`);
      setError("");
    } catch (importError) {
      setError(String(importError));
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

  async function pickAudioFiles(projectId = selectedProject?.id, groupId = "") {
    if (!projectId || !isTauri()) return;
    if (importActiveProjectsRef.current.has(projectId)) {
      setImportTargetId(projectId);
      setImportTargetGroupId(groupId);
      setImportOpen(true);
      return;
    }
    const choice = await open({ multiple: true, directory: false, filters: AUDIO_FILTERS });
    const paths = Array.isArray(choice) ? choice : choice ? [choice] : [];
    if (paths.length) runImport(projectId, paths, false, groupId);
  }

  async function runImport(projectId, paths, allowDuplicates, groupId = "") {
    if (!paths.length || importActiveProjectsRef.current.has(projectId)) {
      setImportTargetId(projectId);
      setImportTargetGroupId(groupId);
      setImportOpen(true);
      return;
    }
    importActiveProjectsRef.current.add(projectId);
    setImportActive(true);
    setImportTargetId(projectId);
    setImportTargetGroupId(groupId);
    setImportOpen(true);
    setDuplicatePaths([]);
    lastImportRequestRef.current = { projectId, paths: [...paths], allowDuplicates, groupId };
    setImportProgress({ projectId, current: 0, total: paths.length, fileName: "", status: "processing", message: "", results: [] });
    try {
      const summary = await invoke("importAudioFiles", { projectId, paths, allowDuplicates, trackGroupId: groupId || null });
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

  return <div className="opal-app" data-view={activeView}>
    <div className="ambient-field" aria-hidden="true" />
    <header className="topbar" data-tauri-drag-region="deep" onMouseDown={handleWindowMouseDown}>
      <div className="topbar-left"><button className="brand-lockup" type="button" onClick={returnToLibrary} aria-label="Open OPAL library"><span className="brand-mark">O</span><span className="brand-name">OPAL</span></button><label className="search-field"><MagnifyingGlass size={14} weight="regular" /><input ref={searchInputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" />{query && <button type="button" className="clear-search" onClick={() => setQuery("")} aria-label="Clear search"><X size={13} /></button>}</label></div>
      <nav className="top-navigation" aria-label="Primary navigation"><button type="button" className={activeView === "library" ? "is-active" : ""} onClick={returnToLibrary}>Library</button><button type="button" className={activeView === "projects" ? "is-active" : ""} onClick={openProjectsView}>Projects</button></nav>
      <div className="topbar-actions">{activeView === "library" && <label className="sort-control topbar-sort-control"><span>Sort</span><select value={sortMode} onChange={(event) => setSortMode(event.target.value)} aria-label="Sort projects"><option value="updated">Recently updated</option><option value="newest">Newest</option><option value="alphabetical">A–Z</option></select><CaretDown size={13} /></label>}<button type="button" className={`topbar-import ${importActive ? "is-busy" : ""}`} onClick={() => importActive ? setImportOpen(true) : (selectedProject ? pickAudioFiles() : setCreateOpen(true))}><Plus size={14} />{importActive ? "Importing…" : "Import"}</button><button type="button" className="profile-button" onClick={openProfile} aria-label="Open OPAL settings" aria-expanded={profileOpen}>SM</button>{profileOpen && <ProfilePopover nativeAvailable={isTauri()} storageInfo={storageInfo} storageError={storageError} preferences={preferences} importProgress={importProgress} onTogglePreference={togglePreference} onRevealFolder={revealStorageFolder} onExportBackup={exportLibraryBackup} onRestoreBackup={restoreLibraryBackup} onRetryStorage={refreshStorageInfo} onDiagnostics={openDiagnostics} onClose={() => setProfileOpen(false)} />}</div>
    </header>
    {error && <div className="error-banner" role="alert"><span>{error}</span><button type="button" onClick={() => setError("")} aria-label="Dismiss message"><X size={14} /></button></div>}
    {notice && <div className="notice-banner" role="status"><span>{notice}</span><button type="button" onClick={() => setNotice("")} aria-label="Dismiss message"><X size={14} /></button></div>}
    <main className="stage">{recoveryMode ? <RecoveryView onRevealFolder={revealStorageFolder} onRestore={restoreLibraryBackup} onRetry={retryStorage} /> : activeView === "project" && selectedProject ? <ProjectView project={selectedProject} playingTrackId={playingProjectId === selectedProject.id ? playingTrackId : ""} focusedTrackId={focusedTrackId} selectedMomentId={selectedMomentId} notesOpen={notesOpen} noteTargetId={noteTargetId} noteText={noteText} noteStatus={noteStatus} nativeAvailable={isTauri()} onBack={returnToLibrary} onTrackSelect={(track) => startPlayback(selectedProject, track)} onVersionSelect={switchVersion} onMomentSelect={selectMoment} onMomentJump={jumpToMoment} onMomentUpdate={updateMoment} onJumpUnresolved={jumpUnresolved} onPlay={() => currentVersions(selectedProject)[0] && startPlayback(selectedProject, currentVersions(selectedProject)[0], 0)} onOpenSequence={() => openSequenceRoom(selectedProject)} onCreateCapsule={() => openCapsuleBuilder(selectedProject)} onExportPackage={() => exportProjectToPhone(selectedProject.id)} onImportReview={() => importPhoneReview(selectedProject.id)} onToggleNotes={() => setNotesOpen((openState) => !openState)} onNoteChange={handleNoteChange} onNoteTargetChange={changeNoteTarget} onImport={() => pickAudioFiles(selectedProject.id)} onAddVersion={(group) => pickAudioFiles(selectedProject.id, group.id)} onEditProject={() => setEditOpen(true)} onEditArtwork={pickArtwork} onRemoveArtwork={removeArtwork} onRemoveProject={() => removeProject(selectedProject)} onRenameTrack={renameTrack} onRenameVersion={renameVersion} onPromoteVersion={promoteVersion} onReorderGroups={reorderTrackGroups} onReorderVersions={reorderTrackVersions} onRemoveVersion={(version, group) => removeVersion(selectedProject, version, group)} /> : activeView === "sequence" && selectedProject ? <SequenceRoom project={selectedProject} playingTrackId={playingProjectId === selectedProject.id ? playingTrackId : ""} playbackState={playbackState} elapsedMs={elapsedMs} durationMs={durationMs || displayTrack?.durationMs || 0} onBack={leaveSequenceRoom} onPlayTrack={playSequenceTrack} onAuditionTransition={auditionTransition} onReorderGroups={reorderTrackGroups} onUpdateTransition={updateTransition} onPlay={() => toggleSequencePlayback(selectedProject)} onPrevious={playPrevious} onNext={playNext} onProgressChange={seekPlayback} onCreateCapsule={() => openCapsuleBuilder(selectedProject)} /> : activeView === "capsule" && selectedProject && capsule ? <CapsuleView capsule={capsule} project={selectedProject} playingTrackId={playingProjectId === selectedProject.id ? playingTrackId : ""} playbackState={playbackState} elapsedMs={elapsedMs} durationMs={durationMs || displayTrack?.durationMs || 0} onBack={leaveCapsuleView} onPlayTrack={playCapsuleTrack} onPlay={() => toggleCapsulePlayback(capsule)} onPrevious={playPrevious} onNext={playNext} onProgressChange={seekPlayback} onCopyReference={() => copyCapsuleReference(capsule)} onOpenResponse={() => setCapsuleResponseOpen(true)} onAddResponse={addCapsuleResponse} /> : activeView === "projects" ? <ProjectsView loading={loading} projects={filteredProjects} query={query} sortMode={sortMode} onSortChange={setSortMode} onOpenProject={openProject} onPlayProject={(project) => currentVersions(project)[0] && startPlayback(project, currentVersions(project)[0], 0)} onCreateProject={() => setCreateOpen(true)} onClearSearch={() => setQuery("")} /> : <LibraryView loading={loading} projects={filteredProjects} selectedId={visibleSelection} query={query} sortMode={sortMode} trackMatches={trackMatches} onSortChange={setSortMode} onProjectSelect={setSelectedId} onOpenProject={openProject} onCreateProject={() => setCreateOpen(true)} onImport={() => (selectedProject ? pickAudioFiles(selectedProject.id) : setCreateOpen(true))} onClearSearch={() => setQuery("")} onStep={(step) => { if (!filteredProjects.length) return; const current = filteredProjects.findIndex((project) => project.id === visibleSelection); const next = (current + step + filteredProjects.length) % filteredProjects.length; setSelectedId(filteredProjects[next].id); }} />}</main>
    {activeView !== "sequence" && activeView !== "capsule" && displayProject && displayTrack && <Player project={displayProject} track={displayTrack} selectedMomentId={selectedMomentId} status={playbackState} playbackError={playbackError} isPlaying={playbackState === "playing"} progress={progressValue} elapsedMs={elapsedMs} durationMs={durationMs || displayTrack.durationMs} volume={volume} muted={muted} volumeOpen={volumeOpen} queueOpen={queueOpen} menuOpen={playerMenuOpen} shuffleEnabled={shuffleEnabled} repeatMode={repeatMode} onTogglePlay={togglePlayback} onPrevious={playPrevious} onNext={playNext} onProgressChange={seekPlayback} onCreateMoment={(timeMs) => createMoment(displayProject, displayTrack, timeMs)} onSelectMoment={(moment) => selectMoment(displayProject, displayTrack, moment)} onVolumeChange={(event) => { setVolume(Number(event.target.value)); setMuted(false); }} onToggleMute={() => setMuted((value) => !value)} onToggleVolume={() => setVolumeOpen((openState) => !openState)} onToggleQueue={() => setQueueOpen((openState) => !openState)} onToggleMenu={() => setPlayerMenuOpen((openState) => !openState)} onToggleShuffle={toggleShuffle} onToggleRepeat={cycleRepeatMode} onOpenProject={() => openProject(displayProject.id)} onShowTrack={() => openProject(displayProject.id, displayTrack.id)} onOpenNotes={() => openProject(displayProject.id, displayTrack.id, displayTrack.id)} onRevealFile={async () => { try { await invoke("revealManagedFile", { managedFileRef: displayTrack.managedFileRef }); } catch (revealError) { setError(String(revealError)); } }} onShowInfo={() => setTrackInfo({ project: displayProject, track: displayTrack })} />}
    {activeView !== "sequence" && activeView !== "capsule" && queueOpen && displayProject && <QueuePopover project={displayProject} currentIndex={displayQueueIndex} onSelect={(track, index) => { startPlayback(displayProject, track, index); setQueueOpen(false); }} onClose={() => setQueueOpen(false)} />}
    {createOpen && <CreateProjectPrompt onClose={() => setCreateOpen(false)} onCreate={createProject} />}
    {editOpen && selectedProject && <ProjectEditorPrompt project={selectedProject} onClose={() => setEditOpen(false)} onSave={updateProject} />}
    {importOpen && importProject && <ImportPrompt project={importProject} groupTitle={importTargetGroup?.title} progress={importProgress} duplicatePaths={duplicatePaths} onClose={closeImport} onChooseFiles={() => pickAudioFiles(importProject.id, importTargetGroupId)} onRetryImport={() => { const request = lastImportRequestRef.current; if (request) runImport(request.projectId, request.paths, request.allowDuplicates, request.groupId); }} onImportDuplicates={() => runImport(importProject.id, duplicatePaths, true, importTargetGroupId)} onSkipDuplicates={() => { setDuplicatePaths([]); setImportProgress((current) => ({ ...(current ?? {}), status: "complete", message: "Duplicates skipped." })); }} />}
    {capsuleCreateOpen && selectedProject && <CreateCapsulePrompt project={selectedProject} onClose={() => setCapsuleCreateOpen(false)} onCreate={(options) => createCapsule(selectedProject, options)} />}
    {capsuleResponseOpen && capsule && <CapsuleResponsePrompt capsule={capsule} currentTrack={selectedProject?.tracks.find((track) => track.id === playingTrackId) ?? capsule.tracks[0]} timeMs={playingProjectId === selectedProject?.id ? elapsedMs : 0} onClose={() => setCapsuleResponseOpen(false)} onSend={addCapsuleResponse} />}
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
  const selectedIndex = visibleProjects.findIndex((project) => project.id === selected.id);
  const offsets = visibleProjects.length === 1 ? [0]
    : visibleProjects.length === 2 ? [0, 1, -1]
      : visibleProjects.length === 3 ? [0, 1, -1]
        : visibleProjects.length === 4 ? [0, 1, 2, -1]
          : [0, 1, 2, -1, -2];
  const cards = offsets.map((offset) => ({
    project: visibleProjects[(selectedIndex + offset + visibleProjects.length) % visibleProjects.length],
    position: offset === 0 ? 0 : offset === 1 ? 1 : offset === 2 ? 2 : offset === -1 ? 3 : 4,
    offset,
  }));
  return <section className="library-screen view-stack" aria-label="OPAL library"><h1 className="library-accessible-title">Library</h1><div className="carousel-wrap"><button type="button" className="carousel-control carousel-control-left" onClick={() => onStep(-1)} aria-label="Previous project"><CaretLeft size={22} /></button><div className="sleeve-orbit" role="group" aria-label="Project artwork selection. Use the left and right arrow keys to change project." onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); onStep(event.key === "ArrowLeft" ? -1 : 1); } }}>{cards.map(({ project, position, offset }) => <button type="button" key={`${project.id}-${offset}`} className={`sleeve sleeve-position-${position} ${project.id === selected.id ? "is-selected" : ""}`} onClick={() => onProjectSelect(project.id)} onDoubleClick={() => onOpenProject(project.id, trackMatches.get(project.id)?.id ?? "")} aria-label={`Select ${project.title}; double-click to open`}><span className="sleeve-image-wrap"><img src={project.artwork} alt="" /></span><span className="sleeve-meta"><strong>{project.title}</strong><small>{project.id === selected.id ? (project.tracks[0]?.title || `${project.count} tracks`) : `${project.count} ${project.count === 1 ? "track" : "tracks"}`}</small></span></button>)}</div><button type="button" className="carousel-control carousel-control-right" onClick={() => onStep(1)} aria-label="Next project"><CaretRight size={22} /></button></div><div className="carousel-caption"><button className="caption-open" type="button" aria-label={`Open ${selected.title} project`} onClick={() => onOpenProject(selected.id, trackMatches.get(selected.id)?.id ?? "")}><span>{selected.description?.trim() || `${selected.count} ${selected.count === 1 ? "track" : "tracks"} · ${selected.duration}`}</span><ArrowUpRight size={16} /></button></div></section>;
}

function SleeveWall({ projects, selectedId, query, sortMode, trackMatches, onSortChange, onProjectSelect, onOpenProject, onCreateProject, onImport }) {
  return <section className="library-screen sleeve-wall-screen view-stack">
    <div className="library-heading-row sleeve-wall-heading"><div><span className="eyebrow">A gathered collection</span><h1>Library</h1></div><div className="sleeve-wall-actions"><label className="sort-control"><span>Sort</span><select value={sortMode} onChange={(event) => onSortChange(event.target.value)} aria-label="Sort projects"><option value="updated">Recently updated</option><option value="newest">Newest</option><option value="alphabetical">A–Z</option></select><CaretDown size={13} /></label><button className="button button-ghost" type="button" onClick={onCreateProject}><Plus size={14} />New project</button></div></div>
    <div className="sleeve-wall" aria-label="Project sleeve wall">{projects.map((project) => { const match = trackMatches.get(project.id); return <article className={`wall-sleeve ${project.id === selectedId ? "is-selected" : ""}`} key={project.id}><button className="wall-sleeve-open" type="button" onClick={() => { onProjectSelect(project.id); onOpenProject(project.id, match?.id ?? ""); }} aria-label={`Open ${project.title}`}><img src={project.artwork} alt="" /><span className="wall-sleeve-glint" aria-hidden="true" /></button><div className="wall-sleeve-meta"><strong title={project.title}>{project.title}</strong><span>{project.count} tracks <em>·</em> {project.duration}</span>{match && <small className="search-hit">Match: {match.title}</small>}</div></article>; })}<button className="wall-create-card" type="button" onClick={onCreateProject}><Plus size={22} /><strong>New project</strong><span>Keep the wall growing</span></button></div>
    <div className="sleeve-wall-footer"><span>{projects.length} projects</span><button className="rail-import" type="button" onClick={onImport}><Plus size={17} /><span>Import audio</span></button><span>{query ? `Results for “${query}”` : "Local library"}</span></div>
  </section>;
}

function ProjectView({ project, playingTrackId, focusedTrackId, selectedMomentId, notesOpen, noteTargetId, noteText, noteStatus, nativeAvailable, onBack, onTrackSelect, onVersionSelect, onMomentSelect, onMomentJump, onMomentUpdate, onJumpUnresolved, onPlay, onOpenSequence, onCreateCapsule, onExportPackage, onImportReview, onToggleNotes, onNoteChange, onNoteTargetChange, onImport, onAddVersion, onEditProject, onEditArtwork, onRemoveArtwork, onRemoveProject, onRenameTrack, onRenameVersion, onPromoteVersion, onReorderGroups, onReorderVersions, onRemoveVersion }) {
  const groups = useMemo(() => groupTracks(project), [project]);
  const [editingGroupId, setEditingGroupId] = useState("");
  const [editingTitle, setEditingTitle] = useState("");
  const [draggedGroupId, setDraggedGroupId] = useState("");
  const [activeGroupId, setActiveGroupId] = useState(groups[0]?.id ?? "");
  const [trackMenuId, setTrackMenuId] = useState("");
  const [versionMenuId, setVersionMenuId] = useState("");

  useEffect(() => {
    if (!groups.some((group) => group.id === activeGroupId)) setActiveGroupId(groups[0]?.id ?? "");
  }, [groups, activeGroupId]);

  useEffect(() => {
    if (!focusedTrackId) return undefined;
    const timer = setTimeout(() => document.getElementById(`track-${focusedTrackId}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 100);
    return () => clearTimeout(timer);
  }, [focusedTrackId]);

  function startEditing(group) {
    setEditingGroupId(group.id);
    setEditingTitle(group.title);
  }

  async function finishEditing(group) {
    const title = editingTitle.trim();
    setEditingGroupId("");
    if (title && title !== group.title) await onRenameTrack(group.current.id, title);
  }

  function moveGroup(index, direction) {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= groups.length) return;
    const ids = groups.map((group) => group.id);
    [ids[index], ids[nextIndex]] = [ids[nextIndex], ids[index]];
    onReorderGroups(ids);
  }

  function dropGroup(targetId) {
    if (!draggedGroupId || draggedGroupId === targetId) return;
    const ids = groups.map((group) => group.id).filter((id) => id !== draggedGroupId);
    const targetIndex = ids.indexOf(targetId);
    ids.splice(targetIndex, 0, draggedGroupId);
    setDraggedGroupId("");
    onReorderGroups(ids);
  }

  function moveVersion(group, index, direction) {
    const nextIndex = index + direction;
    if (nextIndex < 0 || nextIndex >= group.versions.length) return;
    const ids = group.versions.map((version) => version.id);
    [ids[index], ids[nextIndex]] = [ids[nextIndex], ids[index]];
    onReorderVersions(group, ids);
  }

  const noteLabel = noteTargetId ? project.tracks.find((track) => track.id === noteTargetId)?.versionName ?? "Version" : "Project";
  const momentTrack = project.tracks.find((track) => track.id === playingTrackId) ?? groups.find((group) => group.id === activeGroupId)?.current ?? groups[0]?.current ?? null;
  return <section className="project-screen view-stack">
    <div className="project-topline"><button className="back-action" type="button" onClick={onBack}><ArrowLeft size={16} />Library</button><button className="delete-project-action" type="button" onClick={onRemoveProject}><Trash size={14} />Delete project</button></div>
    <div className="project-detail-layout">
      <div className="project-cover-column"><div className="project-sleeve-shell"><img className="project-sleeve" src={project.artwork} alt={`${project.title} artwork`} /></div></div>
      <div className="project-main-column">
        <div className="project-header"><div><h1>{project.title}</h1><p>{project.count} tracks <span>/</span> {project.duration} <span>/</span> {project.year}</p></div><div className="heading-actions"><button className="button button-sequence" type="button" onClick={onOpenSequence} disabled={!project.count}><Queue size={14} />Sequence room</button><button className="button button-capsule" type="button" onClick={onCreateCapsule} disabled={!project.count}><ShareNetwork size={14} />Make capsule</button><button className="button button-ghost" type="button" onClick={onExportPackage} disabled={!nativeAvailable} title={nativeAvailable ? "Create a portable project package for iPhone" : "Project packages require the installed OPAL desktop app"}><Export size={14} />Send to iPhone</button><button className="button button-ghost" type="button" onClick={onImportReview} disabled={!nativeAvailable} title={nativeAvailable ? "Import timestamped notes from an iPhone review" : "Review imports require the installed OPAL desktop app"}><ArrowSquareOut size={14} />Import phone review</button><button className="button button-ghost" type="button" onClick={onToggleNotes} aria-expanded={notesOpen}><NotePencil size={14} />{notesOpen ? "Hide notes" : "Show notes"}</button><button className="button button-ghost" type="button" onClick={onEditProject}>Edit details</button><button className="button button-ghost" type="button" onClick={onEditArtwork}><ImageSquare size={14} />Artwork</button>{project.artworkRef && <button className="button button-danger" type="button" onClick={onRemoveArtwork}><Trash size={14} />Remove</button>}<button className="button button-primary" type="button" onClick={onPlay} disabled={!project.count}><Play size={14} weight="fill" />Play</button></div></div>
        {project.description && <p className="project-description project-description-inline">{project.description}</p>}
        <div className="project-quick-actions"><button className="project-add-tracks" type="button" onClick={onImport}><Plus size={18} />Add tracks</button></div>
        <div className={`project-workspace ${notesOpen ? "" : "notes-closed"}`}><div className="tracklist-panel"><div className="section-heading"><h2>Tracks</h2><span className="section-count">{project.count} {project.count === 1 ? "track" : "tracks"}</span></div><div className="track-list">{groups.map((group, index) => { const current = group.current; const isFocused = group.versions.some((version) => version.id === focusedTrackId); const isPlaying = group.versions.some((version) => version.id === playingTrackId); const menuOpen = trackMenuId === group.id; const ribbonOpen = activeGroupId === group.id && group.versions.length > 1; return <React.Fragment key={group.id}><div className={`track-row ${isPlaying ? "is-current" : ""} ${isFocused ? "is-search-match" : ""} ${draggedGroupId === group.id ? "is-dragging" : ""}`} id={`track-${isFocused ? focusedTrackId : group.id}`} draggable={!editingGroupId} onDragStart={() => setDraggedGroupId(group.id)} onDragEnd={() => setDraggedGroupId("")} onDragOver={(event) => event.preventDefault()} onDrop={() => dropGroup(group.id)}><div className="track-main" role="button" tabIndex={0} onClick={() => { setActiveGroupId(group.id); onTrackSelect(current); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setActiveGroupId(group.id); onTrackSelect(current); } }}><span className="track-number">{String(index + 1).padStart(2, "0")}</span><span className="drag-handle" aria-hidden="true">::</span>{editingGroupId === group.id ? <input className="track-title-editor" autoFocus value={editingTitle} onChange={(event) => setEditingTitle(event.target.value)} onClick={(event) => event.stopPropagation()} onBlur={() => finishEditing(group)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { setEditingGroupId(""); setEditingTitle(group.title); } }} /> : <span className="track-name"><strong>{group.title}</strong><small>{current?.versionName ?? "Original"}{group.versions.length > 1 ? ` · ${group.versions.length} versions` : ""}</small></span>}</div><span className="track-duration">{current?.duration ?? "0:00"}</span><div className="track-actions"><span className="track-menu-wrap"><button type="button" className={`track-action track-menu-trigger ${menuOpen ? "is-active" : ""}`} onClick={(event) => { event.stopPropagation(); setActiveGroupId(group.id); setTrackMenuId(menuOpen ? "" : group.id); }} aria-label={`Open actions for ${group.title}`} aria-expanded={menuOpen}><DotsThree size={17} /></button>{menuOpen && <TrackMenu group={group} index={index} groupCount={groups.length} onMove={(direction) => { setTrackMenuId(""); moveGroup(index, direction); }} onRename={() => { setTrackMenuId(""); startEditing(group); }} onAddVersion={() => { setTrackMenuId(""); onAddVersion(group); }} onNotes={() => { setTrackMenuId(""); onNoteTargetChange(noteTargetId === current?.id ? null : current?.id); }} onRemove={() => { setTrackMenuId(""); onRemoveVersion(current, group); }} onClose={() => setTrackMenuId("")} />}</span></div></div>{ribbonOpen && <div className="version-ribbon" aria-label={`Versions of ${group.title}`}>{group.versions.map((version, versionIndex) => <div className={`version-chip-wrap ${versionMenuId === version.id ? "is-menu-open" : ""}`} key={version.id}><button type="button" className={`version-chip ${version.isCurrent ? "is-current" : ""} ${playingTrackId === version.id ? "is-playing" : ""}`} onClick={() => onVersionSelect(project, version)} aria-pressed={version.isCurrent}><span className="version-chip-marker">{version.isCurrent ? <Check size={11} weight="bold" /> : <span>{String(versionIndex + 1).padStart(2, "0")}</span>}</span><span><strong>{version.versionName}</strong><small>{version.duration}</small></span></button><button type="button" className="version-chip-menu" onClick={() => setVersionMenuId(versionMenuId === version.id ? "" : version.id)} aria-label={`Open actions for ${version.versionName}`} aria-expanded={versionMenuId === version.id}><DotsThree size={15} /></button>{versionMenuId === version.id && <VersionMenu version={version} index={versionIndex} versionCount={group.versions.length} onMove={(direction) => { setVersionMenuId(""); moveVersion(group, versionIndex, direction); }} onRename={() => { setVersionMenuId(""); const nextName = window.prompt("Version name", version.versionName); if (nextName?.trim()) onRenameVersion(version.id, nextName); }} onPromote={() => { setVersionMenuId(""); onPromoteVersion(version); }} onNotes={() => { setVersionMenuId(""); onNoteTargetChange(noteTargetId === version.id ? null : version.id); }} onRemove={() => { setVersionMenuId(""); onRemoveVersion(version, group); }} onClose={() => setVersionMenuId("")} />}</div>)}</div>}</React.Fragment>; })}</div></div>{notesOpen && <aside className="notes-panel glass"><div className="notes-heading"><div><h2>Notes</h2><span className="notes-context">{noteLabel}</span></div><span className={`notes-state is-${noteStatus}`} aria-live="polite">{noteStatus === "saving" ? "Saving" : noteStatus === "error" ? "Couldn’t save" : <><Check size={12} />Saved</>}</span></div><textarea aria-label={`${noteLabel} notes`} value={noteText} onChange={(event) => onNoteChange(event.target.value)} disabled={!nativeAvailable} />{momentTrack && <MomentList project={project} track={momentTrack} selectedMomentId={selectedMomentId} onSelectMoment={(moment) => onMomentSelect(project, momentTrack, moment)} onJumpMoment={onMomentJump} onUpdateMoment={onMomentUpdate} onJumpUnresolved={(direction) => onJumpUnresolved(project, momentTrack, direction)} />}</aside>}</div>
      </div>
    </div>
  </section>;
}

function SequenceRoom({ project, playingTrackId, playbackState, elapsedMs, durationMs, onBack, onPlayTrack, onAuditionTransition, onReorderGroups, onUpdateTransition, onPlay, onPrevious, onNext, onProgressChange, onCreateCapsule }) {
  const groups = useMemo(() => groupTracks(project), [project]);
  const tracks = groups.map((group) => group.current).filter(Boolean);
  const [draggedGroupId, setDraggedGroupId] = useState("");
  const current = tracks.find((track) => track.id === playingTrackId) ?? tracks[0] ?? null;
  const currentIndex = current ? tracks.findIndex((track) => track.id === current.id) : -1;
  const next = currentIndex >= 0 ? tracks[currentIndex + 1] ?? null : tracks[1] ?? null;
  const progress = durationMs > 0 ? Math.min(100, (elapsedMs / durationMs) * 100) : 0;
  const status = playbackState === "transition" ? "Breathing room" : playbackState === "playing" ? "Playing" : playbackState === "loading" ? "Loading" : playbackState === "error" ? "Unavailable" : "Ready to listen";

  function moveGroup(targetId) {
    if (!draggedGroupId || draggedGroupId === targetId) return;
    const ids = groups.map((group) => group.id).filter((id) => id !== draggedGroupId);
    const targetIndex = ids.indexOf(targetId);
    ids.splice(targetIndex, 0, draggedGroupId);
    setDraggedGroupId("");
    onReorderGroups(ids);
  }

  if (!current) return <section className="sequence-room sequence-room-empty"><button className="back-action" type="button" onClick={onBack}><ArrowLeft size={16} />Project</button><div><span className="eyebrow">Sequence room</span><h1>No tracks yet</h1><p>Import a few songs to shape the project arc.</p></div></section>;

  return <section className="sequence-room view-stack">
    <div className="sequence-room-topline"><button className="back-action" type="button" onClick={onBack}><ArrowLeft size={16} />Project</button><div className="sequence-room-title"><span className="eyebrow">Album listening</span><h1>{project.title}</h1></div><div className="sequence-room-actions"><span className="sequence-arc-count">{currentIndex + 1} / {tracks.length} in arc</span><button className="button button-capsule" type="button" onClick={onCreateCapsule}><ShareNetwork size={14} />Make capsule</button></div></div>
    <div className="sequence-hero">
      <div className="sequence-artwork-wrap"><img src={project.artwork} alt={`${project.title} current artwork`} /><span>Now listening</span></div>
      <div className="sequence-hero-copy"><span className="eyebrow">{status}</span><h2>{current.title}</h2><p>{current.versionName} <span>·</span> {current.duration}</p><div className="sequence-transport"><button type="button" onClick={onPrevious} aria-label="Previous track"><SkipBack size={17} weight="fill" /></button><button className="sequence-play" type="button" onClick={onPlay} aria-label={playbackState === "playing" ? "Pause sequence" : "Play sequence"}>{playbackState === "playing" ? <Pause size={19} weight="fill" /> : <Play size={19} weight="fill" />}</button><button type="button" onClick={onNext} aria-label="Next track"><SkipForward size={17} weight="fill" /></button></div><div className="sequence-progress"><div><span>{formatTime(elapsedMs)}</span><span>{formatTime(durationMs)}</span></div><input aria-label="Sequence playback position" type="range" min="0" max="100" value={progress} onChange={onProgressChange} disabled={!durationMs} /></div></div>
      <div className="sequence-next-card"><span className="eyebrow">Next in the arc</span>{next ? <button type="button" onClick={() => onPlayTrack(project, next, currentIndex + 1)}><strong>{next.title}</strong><small>{next.versionName} · {next.duration}</small><span>Play next <ArrowUpRight size={13} /></span></button> : <div className="sequence-finale"><strong>End of sequence</strong><small>The project resolves here.</small></div>}</div>
    </div>
    <div className="sequence-room-grid"><div className="sequence-arc"><div className="sequence-section-heading"><div><span className="eyebrow">Project arc</span><h2>Sequence</h2></div><span>{tracks.length} songs</span></div><div className="sequence-track-list">{tracks.map((track, index) => { const groupId = trackGroupId(track); const following = tracks[index + 1] ?? null; return <React.Fragment key={track.id}><div className={`sequence-track ${track.id === current.id ? "is-current" : ""} ${draggedGroupId === groupId ? "is-dragging" : ""}`} draggable onDragStart={() => setDraggedGroupId(groupId)} onDragEnd={() => setDraggedGroupId("")} onDragOver={(event) => event.preventDefault()} onDrop={() => moveGroup(groupId)}><span className="sequence-track-number">{String(index + 1).padStart(2, "0")}</span><span className="sequence-drag-handle" aria-hidden="true">::</span><button type="button" className="sequence-track-button" onClick={() => onPlayTrack(project, track, index)}><strong>{track.title}</strong><small>{track.versionName} · {track.duration}</small></button>{track.id === current.id && <span className="sequence-now">Now</span>}<button type="button" className="sequence-track-play" onClick={() => onPlayTrack(project, track, index)} aria-label={`Play ${track.title}`}><Play size={13} weight="fill" /></button></div>{following && <SequenceTransition project={project} fromTrack={track} toTrack={following} transition={sequenceTransition(project, track, following)} onUpdateTransition={onUpdateTransition} onAuditionTransition={onAuditionTransition} />}</React.Fragment>; })}</div></div><aside className="sequence-arc-note"><span className="eyebrow">Listening intention</span><h2>Make the arc audible.</h2><p>Reorder the songs, audition the handoffs, and leave space where the record needs to breathe. Sequence settings shape playback only; OPAL never changes the original audio.</p><div className="sequence-next-summary"><span>Coming up</span><strong>{next?.title ?? "The final song"}</strong><small>{next ? "Listen for the handoff above." : "The sequence is complete."}</small></div></aside></div>
  </section>;
}

function SequenceTransition({ project, fromTrack, toTrack, transition, onUpdateTransition, onAuditionTransition }) {
  const [gapMs, setGapMs] = useState(transition?.gapMs ?? 0);
  const [note, setNote] = useState(transition?.note ?? "");
  useEffect(() => {
    setGapMs(transition?.gapMs ?? 0);
    setNote(transition?.note ?? "");
  }, [transition?.gapMs, transition?.note, fromTrack.id, toTrack.id]);

  function save() {
    if (gapMs === (transition?.gapMs ?? 0) && note === (transition?.note ?? "")) return;
    void onUpdateTransition(project, trackGroupId(fromTrack), trackGroupId(toTrack), gapMs, note);
  }

  return <div className="sequence-transition"><div className="sequence-transition-line"><span className="sequence-transition-rule" /><span className="eyebrow">Transition</span><span className="sequence-transition-gap">{formatGap(gapMs)} gap</span><button type="button" onClick={() => onAuditionTransition(project, fromTrack, toTrack)}><Waveform size={13} />Audition</button><span className="sequence-transition-rule" /></div><div className="sequence-gap-control"><span>Silence</span><input aria-label={`Gap between ${fromTrack.title} and ${toTrack.title}`} type="range" min="0" max="30000" step="500" value={gapMs} onChange={(event) => setGapMs(Number(event.target.value))} onPointerUp={save} /><span>{formatGap(gapMs)}</span></div><input className="sequence-transition-note" aria-label={`Note between ${fromTrack.title} and ${toTrack.title}`} placeholder="Transition note — e.g. transition feels abrupt" value={note} onChange={(event) => setNote(event.target.value)} onBlur={save} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></div>;
}

function formatCapsuleExpiry(expiresAt) {
  if (!expiresAt) return "No expiry";
  return `Expires ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(expiresAt))}`;
}

function CreateCapsulePrompt({ project, onClose, onCreate }) {
  const groups = useMemo(() => groupTracks(project), [project]);
  const [selectedVersions, setSelectedVersions] = useState(() => Object.fromEntries(groups.map((group) => [group.id, group.current?.id ?? ""])));
  const [includeNotes, setIncludeNotes] = useState(false);
  const [password, setPassword] = useState("");
  const [expiry, setExpiry] = useState("never");
  const [title, setTitle] = useState(`${project.title} · listening capsule`);
  const [message, setMessage] = useState("");

  function toggleGroup(group) {
    setSelectedVersions((current) => ({ ...current, [group.id]: current[group.id] ? "" : group.current?.id ?? group.versions[0]?.id ?? "" }));
  }

  function submit(event) {
    event.preventDefault();
    const trackIds = groups.map((group) => selectedVersions[group.id]).filter(Boolean);
    const expiryMs = expiry === "day" ? 24 * 60 * 60 * 1000 : expiry === "week" ? 7 * 24 * 60 * 60 * 1000 : expiry === "month" ? 30 * 24 * 60 * 60 * 1000 : 0;
    onCreate({ trackIds, includeNotes, password, expiresAt: expiryMs ? Date.now() + expiryMs : null, title, message });
  }

  const selectedCount = Object.values(selectedVersions).filter(Boolean).length;
  return <DialogFrame titleId="capsule-create-title" onClose={onClose} className="capsule-create-dialog"><button className="modal-close" type="button" onClick={onClose} aria-label="Close capsule builder"><X size={18} /></button><span className="eyebrow">Private presentation</span><h2 id="capsule-create-title">Make a listening capsule</h2><p>Choose the exact versions someone should hear. Their responses can return to this project as moments.</p><form onSubmit={submit}><div className="capsule-selection"><div className="capsule-selection-heading"><span>Sequence</span><strong>{selectedCount} of {groups.length} tracks</strong></div>{groups.map((group) => <div className={`capsule-selection-row ${selectedVersions[group.id] ? "is-selected" : ""}`} key={group.id}><label><input type="checkbox" checked={Boolean(selectedVersions[group.id])} onChange={() => toggleGroup(group)} /><span><strong>{group.title}</strong><small>{selectedVersions[group.id] ? "Included in capsule" : "Left out"}</small></span></label><select aria-label={`Version for ${group.title}`} value={selectedVersions[group.id] ?? ""} onChange={(event) => setSelectedVersions((current) => ({ ...current, [group.id]: event.target.value }))} disabled={!selectedVersions[group.id]}>{group.versions.map((version) => <option key={version.id} value={version.id}>{version.versionName}{version.isCurrent ? " · current" : ""}</option>)}</select></div>)}</div><div className="capsule-form-grid"><div className="modal-field"><label htmlFor="capsule-title">Title</label><input id="capsule-title" value={title} onChange={(event) => setTitle(event.target.value)} required /></div><div className="modal-field"><label htmlFor="capsule-expiry">Expiry</label><select id="capsule-expiry" value={expiry} onChange={(event) => setExpiry(event.target.value)}><option value="never">No expiry</option><option value="day">24 hours</option><option value="week">7 days</option><option value="month">30 days</option></select></div></div><div className="modal-field"><label htmlFor="capsule-message">Message <span>Optional</span></label><textarea id="capsule-message" value={message} onChange={(event) => setMessage(event.target.value)} placeholder="A note for the listener" /></div><div className="capsule-option-row"><label><span><Eye size={16} />Show notes</span><small>{includeNotes ? "Project and track notes travel with the presentation." : "Recipients only hear the intended sequence."}</small></label><input type="checkbox" checked={includeNotes} onChange={(event) => setIncludeNotes(event.target.checked)} /></div><div className="modal-field"><label htmlFor="capsule-password">Password <span>Optional</span></label><div className="capsule-password-field"><LockKey size={15} /><input id="capsule-password" type="password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Leave empty for an open reference" /></div></div><span className="modal-note">Capsules stay in your local OPAL library. Audio is presented in the intended order; original files are never changed.</span><button className="button button-primary modal-cta" type="submit" disabled={!selectedCount}><ShareNetwork size={14} />Create private capsule</button></form></DialogFrame>;
}

function CapsuleView({ capsule, project, playingTrackId, playbackState, elapsedMs, durationMs, onBack, onPlayTrack, onPlay, onPrevious, onNext, onProgressChange, onCopyReference, onOpenResponse }) {
  const current = capsule.tracks.find((track) => track.id === playingTrackId) ?? capsule.tracks[0] ?? null;
  const currentIndex = current ? capsule.tracks.findIndex((track) => track.id === current.id) : -1;
  const next = currentIndex >= 0 ? capsule.tracks[currentIndex + 1] ?? null : capsule.tracks[1] ?? null;
  const progress = durationMs > 0 ? Math.min(100, (elapsedMs / durationMs) * 100) : 0;
  const status = playbackState === "playing" ? "Listening now" : playbackState === "transition" ? "Between songs" : "Ready to listen";
  const trackTitle = new Map(capsule.tracks.map((track) => [track.id, track.title]));

  if (!current) return <section className="capsule-room capsule-room-empty"><button className="back-action" type="button" onClick={onBack}><ArrowLeft size={16} />Project</button><h1>This capsule is empty.</h1></section>;
  return <section className="capsule-room view-stack"><div className="capsule-room-topline"><button className="back-action" type="button" onClick={onBack}><ArrowLeft size={16} />Project</button><div className="capsule-room-title"><span className="eyebrow">Listening capsule</span><h1>{capsule.title}</h1></div><div className="capsule-room-actions"><span className="capsule-protection">{capsule.hasPassword ? <><LockKey size={13} />Private</> : <><ShieldCheck size={13} />Private reference</>} </span><button className="button button-capsule" type="button" onClick={onCopyReference}><Copy size={14} />Copy reference</button></div></div><div className="capsule-hero"><div className="capsule-artwork-wrap"><img src={capsule.artwork} alt={`${capsule.projectTitle} artwork`} /><span>{formatCapsuleExpiry(capsule.expiresAt)}</span></div><div className="capsule-hero-copy"><span className="eyebrow">{status}</span><h2>{capsule.projectTitle}</h2><p>{capsule.message || capsule.projectDescription || "A focused listen through the project."}</p><div className="capsule-hero-meta"><span>{capsule.tracks.length} selected versions</span><span>{capsule.includeNotes ? "Notes included" : "Listening only"}</span></div><div className="capsule-transport"><button type="button" onClick={onPrevious} aria-label="Previous capsule track"><SkipBack size={17} weight="fill" /></button><button className="capsule-play" type="button" onClick={onPlay} aria-label={playbackState === "playing" ? "Pause capsule" : "Play capsule"}>{playbackState === "playing" ? <Pause size={19} weight="fill" /> : <Play size={19} weight="fill" />}</button><button type="button" onClick={onNext} aria-label="Next capsule track"><SkipForward size={17} weight="fill" /></button></div><div className="capsule-progress"><div><span>{formatTime(elapsedMs)}</span><span>{formatTime(durationMs)}</span></div><input aria-label="Capsule playback position" type="range" min="0" max="100" value={progress} onChange={onProgressChange} disabled={!durationMs} /></div><button className="capsule-response-cta" type="button" onClick={onOpenResponse}><PaperPlaneTilt size={14} />Respond to this moment</button></div><div className="capsule-next-card"><span className="eyebrow">Next in the presentation</span>{next ? <button type="button" onClick={() => onPlayTrack(capsule, next, currentIndex + 1)}><strong>{next.title}</strong><small>{next.versionName} · {next.duration}</small><span>Play next <ArrowUpRight size={13} /></span></button> : <div className="sequence-finale"><strong>End of capsule</strong><small>The listen resolves here.</small></div>}</div></div><div className="capsule-room-grid"><div className="capsule-sequence"><div className="capsule-section-heading"><div><span className="eyebrow">Intended order</span><h2>{capsule.title}</h2></div><span>{currentIndex + 1} / {capsule.tracks.length}</span></div><div className="capsule-track-list">{capsule.tracks.map((track, index) => <button type="button" className={`capsule-track ${track.id === current.id ? "is-current" : ""}`} key={track.id} onClick={() => onPlayTrack(capsule, track, index)}><span className="capsule-track-number">{String(index + 1).padStart(2, "0")}</span><span><strong>{track.title}</strong><small>{track.versionName} · {track.duration}</small></span>{track.id === current.id && <span className="capsule-now">Now</span>}<Play size={13} weight="fill" /></button>)}</div></div><aside className="capsule-notes"><span className="eyebrow">{capsule.includeNotes ? "Artist notes" : "A quiet listen"}</span><h2>{capsule.includeNotes ? "Hear the thinking around it." : "Only the sequence travels."}</h2>{capsule.includeNotes ? <div className="capsule-note-list">{capsule.projectNote?.text && <p>{capsule.projectNote.text}</p>}{capsule.tracks.filter((track) => track.note?.text).map((track) => <div key={track.id}><small>{track.title} · {track.versionName}</small><p>{track.note.text}</p></div>)}{capsule.transitions.filter((transition) => transition.note).map((transition) => <div key={transition.id}><small>Between songs</small><p>{transition.note}</p></div>)}{!capsule.projectNote?.text && !capsule.tracks.some((track) => track.note?.text) && !capsule.transitions.some((transition) => transition.note) && <p className="capsule-muted-copy">No notes were added to this presentation.</p>}</div> : <p>Artwork, versions, and intended order stay in focus. Private responses can still return to the artist’s OPAL decision trail.</p>}<div className="capsule-arc-summary"><span>Project arc</span><strong>{capsule.projectTitle}</strong><small>{formatCapsuleExpiry(capsule.expiresAt)}</small></div></aside></div><section className="capsule-responses"><div className="capsule-section-heading"><div><span className="eyebrow">Decision trail</span><h2>Responses</h2></div><span>{capsule.responses.length ? `${capsule.responses.length} returned` : "Nothing returned yet"}</span></div>{capsule.responses.length ? <div className="capsule-response-list">{capsule.responses.map((response) => <article key={response.id}><span className={`capsule-response-state state-${response.state}`}>{momentStateLabel(response.state)}</span><div><strong>{trackTitle.get(response.trackId) ?? "Track"} · {formatTime(response.timeMs)}</strong><p>{response.text}</p></div><small>Returned to OPAL</small></article>)}</div> : <div className="capsule-response-empty"><Broadcast size={17} /><span>Listeners can leave a moment here. It will appear on the matching version in OPAL.</span></div>}</section></section>;
}

function CapsuleResponsePrompt({ capsule, currentTrack, timeMs, onClose, onSend }) {
  const [trackId, setTrackId] = useState(currentTrack?.id ?? capsule.tracks[0]?.id ?? "");
  const [responseTime, setResponseTime] = useState(timeMs || 0);
  const [state, setState] = useState("question");
  const [text, setText] = useState("");
  const track = capsule.tracks.find((item) => item.id === trackId) ?? capsule.tracks[0];
  useEffect(() => {
    setTrackId(currentTrack?.id ?? capsule.tracks[0]?.id ?? "");
    setResponseTime(timeMs || 0);
  }, [currentTrack?.id, timeMs, capsule.id]);
  return <DialogFrame titleId="capsule-response-title" onClose={onClose} className="capsule-response-dialog"><button className="modal-close" type="button" onClick={onClose} aria-label="Close capsule response"><X size={18} /></button><span className="eyebrow">Return a moment</span><h2 id="capsule-response-title">Leave a response</h2><p>This will come back to the artist as an unresolved OPAL moment.</p><form onSubmit={(event) => { event.preventDefault(); onSend(capsule, track, responseTime, state, text); }}><div className="capsule-form-grid"><div className="modal-field"><label htmlFor="capsule-response-track">Track</label><select id="capsule-response-track" value={trackId} onChange={(event) => setTrackId(event.target.value)}>{capsule.tracks.map((item) => <option key={item.id} value={item.id}>{item.title} · {item.versionName}</option>)}</select></div><div className="modal-field"><label htmlFor="capsule-response-state">Decision</label><select id="capsule-response-state" value={state} onChange={(event) => setState(event.target.value)}>{MOMENT_STATES.map((item) => <option key={item} value={item}>{MOMENT_STATE_LABELS[item]}</option>)}</select></div></div><div className="modal-field"><label htmlFor="capsule-response-time">Moment <span>{formatTime(responseTime)}</span></label><input id="capsule-response-time" type="range" min="0" max={track?.durationMs || 0} value={responseTime} onChange={(event) => setResponseTime(Number(event.target.value))} disabled={!track?.durationMs} /></div><div className="modal-field"><label htmlFor="capsule-response-text">Response</label><textarea id="capsule-response-text" autoFocus value={text} onChange={(event) => setText(event.target.value)} placeholder="What should the artist hear here?" required /></div><button className="button button-primary modal-cta" type="submit" disabled={!text.trim()}><PaperPlaneTilt size={14} />Return to OPAL</button></form></DialogFrame>;
}

function TrackMenu({ group, index, groupCount, onMove, onRename, onAddVersion, onNotes, onRemove, onClose }) {
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

  return <div ref={menuRef} className="track-menu glass" data-popover role="menu" aria-label={`Actions for ${group.title}`}>
    <span className="eyebrow">Track actions</span>
    <button type="button" role="menuitem" onClick={() => onMove(-1)} disabled={index === 0}><CaretLeft size={14} />Move earlier</button>
    <button type="button" role="menuitem" onClick={() => onMove(1)} disabled={index === groupCount - 1}><CaretRight size={14} />Move later</button>
    <button type="button" role="menuitem" onClick={onAddVersion}><Plus size={14} />Add bounce</button>
    <button type="button" role="menuitem" onClick={onRename}><NotePencil size={14} />Rename track</button>
    <button type="button" role="menuitem" onClick={onNotes}><NotePencil size={14} />Open notes</button>
    <button type="button" className="track-menu-danger" role="menuitem" onClick={onRemove} disabled={group.versions.length <= 1}><Trash size={14} />Remove current version</button>
  </div>;
}

function VersionMenu({ version, index, versionCount, onMove, onRename, onPromote, onNotes, onRemove, onClose }) {
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
  return <div ref={menuRef} className="version-menu glass" data-popover role="menu" aria-label={`Actions for ${version.versionName}`}>
    <span className="eyebrow">Version actions</span>
    <button type="button" role="menuitem" onClick={() => onMove(-1)} disabled={index === 0}><CaretLeft size={14} />Move earlier</button>
    <button type="button" role="menuitem" onClick={() => onMove(1)} disabled={index === versionCount - 1}><CaretRight size={14} />Move later</button>
    <button type="button" role="menuitem" onClick={onRename}><NotePencil size={14} />Rename version</button>
    <button type="button" role="menuitem" onClick={onPromote} disabled={version.isCurrent}><Check size={14} />{version.isCurrent ? "Current version" : "Make current"}</button>
    <button type="button" role="menuitem" onClick={onNotes}><NotePencil size={14} />{version.note?.text ? "Edit notes" : "Open notes"}</button>
    <button type="button" className="track-menu-danger" role="menuitem" onClick={onRemove} disabled={versionCount <= 1}><Trash size={14} />Remove version</button>
  </div>;
}

function MomentList({ project, track, selectedMomentId, onSelectMoment, onJumpMoment, onUpdateMoment, onJumpUnresolved }) {
  const moments = [...(track.moments ?? [])].sort((left, right) => left.timeMs - right.timeMs);
  const group = groupTracks(project).find((item) => item.versions.some((version) => version.id === track.id));
  const versions = group?.versions ?? [track];
  const [compareMomentId, setCompareMomentId] = useState("");
  const selectedMoment = moments.find((moment) => moment.id === compareMomentId) ?? null;

  useEffect(() => {
    if (compareMomentId && !moments.some((moment) => moment.id === compareMomentId)) setCompareMomentId("");
  }, [compareMomentId, moments]);

  const unresolvedCount = moments.filter((moment) => !moment.isResolved).length;
  return <section className="moment-section" aria-label="Annotation halo"><div className="moment-section-heading"><div><span className="eyebrow">Annotation halo</span><h3>Moments</h3></div><div className="moment-nav"><button type="button" onClick={() => onJumpUnresolved(-1)} disabled={!unresolvedCount} aria-label="Previous unresolved moment" title="Previous unresolved moment"><CaretLeft size={13} /></button><span>{unresolvedCount ? `${unresolvedCount} open` : "All clear"}</span><button type="button" onClick={() => onJumpUnresolved(1)} disabled={!unresolvedCount} aria-label="Next unresolved moment" title="Next unresolved moment"><CaretRight size={13} /></button></div></div>{moments.length ? <div className="moment-list">{moments.map((moment) => <MomentCard key={moment.id} project={project} track={track} moment={moment} versions={versions} selected={moment.id === selectedMomentId} onSelect={onSelectMoment} onJump={onJumpMoment} onUpdate={onUpdateMoment} onCompare={() => setCompareMomentId(compareMomentId === moment.id ? "" : moment.id)} />)}</div> : <div className="moment-empty"><Waveform size={16} /><span>Click the waveform to leave a timestamped decision.</span></div>}{selectedMoment && <MomentCompare project={project} track={track} moment={selectedMoment} versions={versions} onJumpMoment={onJumpMoment} onClose={() => setCompareMomentId("")} />}</section>;
}

function MomentCard({ project, track, moment, versions, selected, onSelect, onJump, onUpdate, onCompare }) {
  const [draftText, setDraftText] = useState(moment.text);
  useEffect(() => setDraftText(moment.text), [moment.id, moment.text]);
  const saveText = () => {
    if (draftText !== moment.text) onUpdate(project, moment, { text: draftText });
  };
  return <article className={`moment-card state-${moment.state} ${moment.isResolved ? "is-resolved" : ""} ${selected ? "is-selected" : ""}`} onClick={() => onSelect?.(moment)}><div className="moment-card-top"><button type="button" className="moment-time" onClick={() => onJump(project, track, moment)}><span className="moment-dot" aria-hidden="true" />{formatTime(moment.timeMs)}</button><span className={`moment-decision state-${moment.state}`}>{momentStateLabel(moment.state)}</span><button type="button" className="moment-resolve" onClick={() => onUpdate(project, moment, { isResolved: !moment.isResolved })}>{moment.isResolved ? "Reopen" : "Resolve"}</button></div><div className="moment-state-picker" aria-label={`Decision for ${formatTime(moment.timeMs)}`}>{MOMENT_STATES.map((state) => <button type="button" key={state} className={moment.state === state ? "is-active" : ""} onClick={() => onUpdate(project, moment, { state })} aria-pressed={moment.state === state}>{momentStateLabel(state)}</button>)}</div><input className="moment-text" value={draftText} onChange={(event) => setDraftText(event.target.value)} onBlur={saveText} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} placeholder="What should change here?" aria-label={`Note for moment at ${formatTime(moment.timeMs)}`} /><div className="moment-card-footer"><span>{moment.isResolved ? "Kept in history" : "Needs a decision"}</span>{versions.length > 1 && <button type="button" className="moment-compare-button" onClick={onCompare}>Compare versions</button>}</div></article>;
}

function MomentCompare({ project, track, moment, versions, onJumpMoment, onClose }) {
  const otherVersions = versions.filter((version) => version.id !== track.id);
  const [compareVersionId, setCompareVersionId] = useState(otherVersions[0]?.id ?? "");
  useEffect(() => {
    if (!otherVersions.some((version) => version.id === compareVersionId)) setCompareVersionId(otherVersions[0]?.id ?? "");
  }, [compareVersionId, otherVersions]);
  const compareTrack = otherVersions.find((version) => version.id === compareVersionId) ?? otherVersions[0] ?? null;
  const compareMoment = compareTrack?.moments?.find((item) => item.lineageId === moment.lineageId) ?? null;
  return <div className="moment-compare"><div className="moment-compare-heading"><div><span className="eyebrow">Same marked section</span><strong>Compare versions</strong></div><button type="button" onClick={onClose} aria-label="Close moment comparison"><X size={14} /></button></div>{otherVersions.length > 1 && <label className="moment-compare-select"><span>Compare with</span><select value={compareTrack?.id ?? ""} onChange={(event) => setCompareVersionId(event.target.value)}>{otherVersions.map((version) => <option key={version.id} value={version.id}>{version.versionName}</option>)}</select></label>}<div className="moment-compare-grid"><div className="moment-compare-card"><span className="eyebrow">A · {track.versionName}</span><strong>{formatTime(moment.timeMs)}</strong><small>{momentStateLabel(moment.state)}{moment.isResolved ? " · Resolved" : " · Open"}</small><button type="button" onClick={() => onJumpMoment(project, track, moment)}>Play this moment</button></div><div className="moment-compare-connector" aria-hidden="true">↔</div><div className="moment-compare-card"><span className="eyebrow">B · {compareTrack?.versionName ?? "Version"}</span>{compareTrack ? <><strong>{formatTime(compareMoment?.timeMs ?? moment.timeMs)}</strong><small>{compareMoment ? `${momentStateLabel(compareMoment.state)}${compareMoment.isResolved ? " · Resolved" : " · Open"}` : "No linked decision"}</small><button type="button" onClick={() => compareMoment && onJumpMoment(project, compareTrack, compareMoment)} disabled={!compareMoment}>Play this moment</button></> : <small>Add another version to compare this section.</small>}</div></div></div>;
}

function WaveformProgress({ track, progress, durationMs, moments = [], selectedMomentId, onChange, onSelectMoment }) {
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
    {moments.filter((moment) => durationMs > 0 && moment.timeMs >= 0 && moment.timeMs <= durationMs).map((moment) => <button type="button" key={moment.id} className={`moment-marker state-${moment.state} ${moment.isResolved ? "is-resolved" : ""} ${selectedMomentId === moment.id ? "is-selected" : ""}`} style={{ left: `${(moment.timeMs / durationMs) * 100}%` }} onClick={(event) => { event.stopPropagation(); onSelectMoment?.(moment); }} aria-label={`${momentStateLabel(moment.state)} moment at ${formatTime(moment.timeMs)}`} title={`${momentStateLabel(moment.state)} · ${formatTime(moment.timeMs)}`} />)}
    <input className="waveform-input" aria-label="Playback position" title="Click or drag to seek. Add a moment from the track menu." type="range" min="0" max="100" value={safeProgress} onChange={onChange} disabled={!durationMs} />
  </div>;
}

function Player({ project, track, selectedMomentId, status, playbackError, isPlaying, progress, elapsedMs, durationMs, volume, muted, volumeOpen, queueOpen, menuOpen, shuffleEnabled, repeatMode, onTogglePlay, onPrevious, onNext, onProgressChange, onCreateMoment, onSelectMoment, onVolumeChange, onToggleMute, onToggleVolume, onToggleQueue, onToggleMenu, onToggleShuffle, onToggleRepeat, onOpenProject, onShowTrack, onOpenNotes, onRevealFile, onShowInfo }) {
  const statusText = status === "loading" ? "Loading" : status === "error" ? "Unavailable" : `${track.versionName ?? "Original"} · ${project.title}`;
  const repeatLabel = repeatMode === "track" ? "Repeat track" : repeatMode === "project" ? "Repeat project" : "Repeat off";
  return <section className="player-shell glass" aria-label="Audio player">
    <div className="player-controls">
      <button type="button" onClick={onPrevious} aria-label="Previous track" title="Previous track"><SkipBack size={18} weight="fill" /></button>
      <button type="button" className="play-button" onClick={onTogglePlay} aria-label={isPlaying ? "Pause" : "Play"} aria-keyshortcuts="Space" title={`${isPlaying ? "Pause" : "Play"} (Space)`}>{isPlaying ? <Pause size={18} weight="fill" /> : <Play size={18} weight="fill" />}</button>
      <button type="button" onClick={onNext} aria-label="Next track" title="Next track"><SkipForward size={18} weight="fill" /></button>
    </div>
    <div className="player-center" key={`${project.id}:${track.id}`}>
      <div className="player-track">
        <img src={project.artwork} alt="" />
        <span><strong>{track.title}</strong><small>{playbackError || statusText}</small></span>
        <button className="player-waveform-action" type="button" onClick={onOpenNotes} aria-label="Open track notes" title="Open track notes"><Waveform size={17} /></button>
        <span className="player-menu-wrap"><button className="player-more" type="button" onClick={onToggleMenu} aria-label="Open player menu" aria-expanded={menuOpen} title="Track options"><DotsThree size={18} /></button>{menuOpen && <PlayerMenu track={track} elapsedMs={elapsedMs} onCreateMoment={onCreateMoment} onOpenProject={onOpenProject} onShowTrack={onShowTrack} onOpenNotes={onOpenNotes} onRevealFile={onRevealFile} onShowInfo={onShowInfo} onClose={onToggleMenu} />}</span>
      </div>
      <div className="player-progress">
        <div className="player-progress-top"><span>{formatTime(elapsedMs)}</span><span>{formatTime(durationMs)}</span></div>
        <WaveformProgress track={track} moments={track.moments} selectedMomentId={selectedMomentId} progress={progress} durationMs={durationMs} onChange={onProgressChange} onSelectMoment={onSelectMoment} />
      </div>
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

function PlayerMenu({ track, elapsedMs, onCreateMoment, onOpenProject, onShowTrack, onOpenNotes, onRevealFile, onShowInfo, onClose }) {
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
  return <div ref={menuRef} className="player-menu glass" data-popover role="menu" aria-label={`Actions for ${track.title}`}><span className="eyebrow">Current track</span><button type="button" role="menuitem" onClick={() => run(() => onCreateMoment?.(elapsedMs))} disabled={!onCreateMoment || !track.durationMs}><NotePencil size={15} />Add moment here</button><button type="button" role="menuitem" onClick={() => run(onOpenProject)}><FolderOpen size={15} />Open project</button><button type="button" role="menuitem" onClick={() => run(onShowTrack)}><ListBullets size={15} />Show in project</button><button type="button" role="menuitem" onClick={() => run(onOpenNotes)}><NotePencil size={15} />Open track notes</button><button type="button" role="menuitem" onClick={() => run(onRevealFile)} disabled={!track.managedFilePath} title={track.managedFilePath ? "Reveal the managed audio file" : "The managed audio file is missing"}><ArrowSquareOut size={15} />Reveal managed file</button><button type="button" role="menuitem" onClick={() => run(onShowInfo)}><Info size={15} />Track information</button></div>;
}

function TrackInfoDialog({ project, track, onClose }) {
  return <DialogFrame titleId="track-info-title" onClose={onClose} className="info-dialog"><button className="modal-close" type="button" onClick={onClose} aria-label="Close track information"><X size={18} /></button><span className="eyebrow">Track version</span><h2 id="track-info-title">{track.title}</h2><p className="dialog-subtitle">{track.versionName ?? "Original"} · {project.title}</p><dl className="info-list"><div><dt>Source title</dt><dd>{track.sourceTitle || track.title}</dd></div><div><dt>Format</dt><dd>{track.format || "Unknown"}</dd></div><div><dt>Duration</dt><dd>{track.duration}</dd></div><div><dt>Current</dt><dd>{track.isCurrent ? "Yes" : "No"}</dd></div><div><dt>Managed audio</dt><dd>{track.managedFilePath ? "Available" : "Missing"}</dd></div><div><dt>Notes</dt><dd>{track.note?.text ? "Has notes" : "Empty"}</dd></div></dl><button className="button button-primary modal-cta" type="button" onClick={onClose}>Done</button></DialogFrame>;
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
  const nextTracks = currentVersions(project).slice(Math.max(0, currentIndex + 1), currentIndex + 4);
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

function ImportPrompt({ project, groupTitle, progress, duplicatePaths, onClose, onChooseFiles, onRetryImport, onImportDuplicates, onSkipDuplicates }) {
  const results = progress?.results ?? [];
  const total = progress?.total ?? 0;
  const current = Math.min(progress?.current ?? 0, total);
  const progressPercent = total ? (current / total) * 100 : 0;
  return <DialogFrame titleId="import-title" onClose={onClose} dismissOnBackdrop={false}><button className="modal-close" type="button" onClick={onClose} aria-label="Close import prompt"><X size={18} /></button><span className="eyebrow">{groupTitle ? "Add a version" : "New tracks"}</span><h2 id="import-title">{groupTitle ? `Add bounce to ${groupTitle}` : "Import audio"}</h2><p>{groupTitle ? "This bounce will stay with the track and keep its own notes." : "Files are copied into OPAL storage. Originals stay untouched."}</p><button className="drop-zone" type="button" onClick={onChooseFiles}><FileAudio size={26} weight="thin" /><strong>Choose audio</strong><span>WAV · MP3 · FLAC · AIFF · M4A</span></button>{progress && <div className="import-summary"><div className="import-summary-top"><span>{progress.status === "processing" ? "Importing" : progress.status === "error" ? "Import error" : progress.status === "duplicates" ? "Duplicates" : "Complete"}</span><strong>{current}/{total}</strong></div><div className="import-progress-bar"><span style={{ width: `${progressPercent}%` }} /></div>{progress.message && <small>{progress.message}</small>}</div>}{results.length > 0 && <div className="import-results">{results.map((result) => <div className={`import-result is-${result.status}`} key={`${result.path}-${result.status}`}><span><strong>{result.fileName}</strong><small>{result.message}</small></span><em>{result.status}</em></div>)}</div>}{progress?.status === "error" && <div className="import-actions"><button className="button button-primary" type="button" onClick={onRetryImport}>Retry import</button></div>}{duplicatePaths.length > 0 && <div className="import-actions"><button className="button button-primary" type="button" onClick={onImportDuplicates}>Import duplicates</button><button className="button button-ghost" type="button" onClick={onSkipDuplicates}>Skip duplicates</button></div>}</DialogFrame>;
}

export { App };
