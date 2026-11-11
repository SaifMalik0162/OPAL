import React, { useEffect, useMemo, useRef, useState } from "react";
import { convertFileSrc, invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import { check } from "@tauri-apps/plugin-updater";
import { exit, relaunch } from "@tauri-apps/plugin-process";
import packageMetadata from "../package.json";
import { Onboarding } from "./Onboarding.jsx";
import { OnboardingAmbient } from "./OnboardingAmbient.jsx";
import { UpdateDialog } from "./UpdateDialog.jsx";
import { isCurrentPlaybackRequest, previousQueueIndex, repeatQueueIndex, shuffleQueue } from "./playback-queue.js";
import { remainingGapMilliseconds } from "./playback-gap.js";
import { reconcilePlayingQueue } from "./queue-state.js";
import { shouldApplyNoteSave } from "./note-revisions.js";
import { createNoteStore, noteKeyParts } from "./note-store.js";
import { playbackErrorMessage } from "./audio-playback-error.js";
import { serializeDiagnosticsReport } from "./diagnostics-report.js";
import { readCachedWaveform, writeCachedWaveform } from "./waveform-cache.js";
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
  DotsSixVertical,
  Export,
  FileAudio,
  FolderOpen,
  GearSix,
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
  Rewind,
  FastForward,
  SkipBack,
  SkipForward,
  SpeakerHigh,
  SpeakerX,
  ShareNetwork,
  ShieldCheck,
  Trash,
  WarningCircle,
  Waveform,
  X,
} from "@phosphor-icons/react";

const FALLBACK_ARTWORK = "/artwork/opal-default-cover.png";
const AUDIO_FILTERS = [{ name: "Audio", extensions: ["wav", "mp3", "flac", "aiff", "aif", "m4a"] }];
const ARTWORK_FILTERS = [{ name: "Artwork", extensions: ["png", "jpg", "jpeg", "webp"] }];
const PLAYBACK_STORAGE_KEY = "opal-playback-v1";
const SORT_STORAGE_KEY = "opal-sort-v1";
const WELCOME_STORAGE_KEY = "opal-welcome-v1";
const APP_VERSION = packageMetadata.version;

function isRecoveryError(value) {
  return String(value).startsWith("RECOVERY_REQUIRED:");
}

function isCompatibilityError(value) {
  return String(value).startsWith("COMPATIBILITY_REQUIRED:");
}

function compatibilityMessage(value) {
  return String(value).replace(/^COMPATIBILITY_REQUIRED:\s*/, "");
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
  return `${(value / (1024 ** index)).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function capsuleDeletionWarning(impact = {}) {
  const capsules = Number(impact.affectedCapsules ?? 0);
  const responses = Number(impact.affectedResponses ?? 0);
  if (!capsules && !responses) return "";
  const capsuleLabel = `${capsules} listening Capsule${capsules === 1 ? "" : "s"}`;
  const responseLabel = `${responses} response${responses === 1 ? "" : "s"}`;
  return ` This also deletes ${capsuleLabel} and ${responseLabel}; their local references will stop opening.`;
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
  useEffect(() => {
    const platform = navigator.platform || navigator.userAgent;
    document.documentElement.dataset.platform = isTauri() && /Mac/i.test(platform) ? "macos" : "other";
    return () => delete document.documentElement.dataset.platform;
  }, []);
  const [activeView, setActiveView] = useState("library");
  const [projects, setProjects] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [recoveryMode, setRecoveryMode] = useState(false);
  const [compatibilityMode, setCompatibilityMode] = useState(false);
  const [welcomeOpen, setWelcomeOpen] = useState(() => {
    if (!isTauri()) return false;
    try {
      return localStorage.getItem(WELCOME_STORAGE_KEY) !== "seen";
    } catch {
      return true;
    }
  });
  const showWelcome = welcomeOpen && !loading && !recoveryMode && !compatibilityMode;

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
  const [updateOpen, setUpdateOpen] = useState(false);
  const [updateBannerPreview, setUpdateBannerPreview] = useState(0);
  const showUpdateBannerPreview = (import.meta.env.DEV || import.meta.env.VITE_OPAL_DEVELOPMENT === "1") && updateBannerPreview > 0;
  const [availableUpdate, setAvailableUpdate] = useState(null);
  const [updateStatus, setUpdateStatus] = useState("idle");
  const [updateError, setUpdateError] = useState("");
  const [updateProgress, setUpdateProgress] = useState({ received: 0, total: 0 });
  const [libraryOperation, setLibraryOperation] = useState("");
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [diagnostics, setDiagnostics] = useState(null);
  const [diagnosticsNotice, setDiagnosticsNotice] = useState("");
  const [trackInfo, setTrackInfo] = useState(null);
  const [confirmState, setConfirmState] = useState(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
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
  const [capsuleSummaries, setCapsuleSummaries] = useState([]);
  const [capsuleShelfLoading, setCapsuleShelfLoading] = useState(false);
  const [capsuleUnlockTarget, setCapsuleUnlockTarget] = useState(null);
  const [capsuleUnlockError, setCapsuleUnlockError] = useState("");
  const [capsuleCreateOpen, setCapsuleCreateOpen] = useState(false);
  const [capsuleResponseOpen, setCapsuleResponseOpen] = useState(false);
  const audioRef = useRef(null);
  const playbackRef = useRef({ requestId: 0, project: null, projectId: "", trackId: "", queue: [], index: -1, sequenceMode: false, gapTimer: null, gapEndsAt: null, gapRemainingMs: 0 });
  const shuffleRef = useRef(false);
  const repeatRef = useRef("off");
  const lastTimeUpdateRef = useRef(0);
  const momentShortcutRef = useRef(null);
  const noteTimerRef = useRef(null);
  const noteContextRef = useRef({ key: "", draftText: "", persistedText: "", revision: 0 });
  const noteTextRef = useRef("");
  const noteRevisionRef = useRef(0);
  const noteStoreRef = useRef(null);
  const searchInputRef = useRef(null);
  const closeInProgressRef = useRef(false);
  const importActiveProjectsRef = useRef(new Set());
  const lastImportRequestRef = useRef(null);
  const capsulePasswordRef = useRef("");

  if (!noteStoreRef.current) noteStoreRef.current = createNoteStore(window.localStorage);

  useEffect(() => {
    if (!isTauri() || import.meta.env.DEV || import.meta.env.VITE_OPAL_DEVELOPMENT === "1") return;
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const update = await check();
        if (!cancelled && update) setAvailableUpdate(update);
      } catch {
        // Network or feed errors stay quiet during the automatic check.
      }
    }, 1800);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, []);

  const selectedProject = projects.find((project) => project.id === selectedId) ?? null;
  const playingProject = projects.find((project) => project.id === playingProjectId) ?? null;
  const playingTrack = playingProject?.tracks.find((track) => track.id === playingTrackId) ?? null;
  const displayProject = playingProject ?? selectedProject;
  const displayTrack = playingTrack ?? currentVersions(selectedProject)[0] ?? null;
  momentShortcutRef.current = { project: displayProject, track: displayTrack, timeMs: elapsedMs, durationMs: durationMs || displayTrack?.durationMs || 0 };
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
      setCompatibilityMode(false);
      const nextSelection = nextProjects.find((project) => project.id === preferredId) ?? nextProjects[0] ?? null;
      setSelectedId(nextSelection?.id ?? "");
      if (!nextSelection) setActiveView("library");
      setError("");
      return nextProjects;
    } catch (loadError) {
      setProjects([]);
      setError(isCompatibilityError(loadError) ? "" : String(loadError));
      setRecoveryMode(isRecoveryError(loadError));
      setCompatibilityMode(isCompatibilityError(loadError));
      return [];
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reloadProjects();
  }, []);

  useEffect(() => {
    if (!isTauri() || activeView !== "project" || !selectedId) {
      setCapsuleSummaries([]);
      setCapsuleShelfLoading(false);
      return undefined;
    }
    let cancelled = false;
    setCapsuleSummaries([]);
    setCapsuleShelfLoading(true);
    invoke("listCapsules", { projectId: selectedId }).then((summaries) => {
      if (!cancelled) setCapsuleSummaries(summaries ?? []);
    }).catch((capsuleListError) => {
      if (!cancelled) setError(String(capsuleListError));
    }).finally(() => {
      if (!cancelled) setCapsuleShelfLoading(false);
    });
    return () => { cancelled = true; };
  }, [selectedId, activeView]);

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
    function isTextEntryTarget(target) {
      return target?.matches?.("input:not([type='range']), textarea, select, [contenteditable='true']");
    }
    function isEditableTarget(target) {
      return target?.matches?.("input, textarea, select, button, [contenteditable='true']");
    }
    function handleKeyboardShortcuts(event) {
      if (showWelcome) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInputRef.current?.focus();
        return;
      }
      if (event.target?.closest?.("[role='dialog'], [data-popover]")) return;
      if (event.key.toLowerCase() === "m" && !event.repeat && !event.metaKey && !event.ctrlKey && !event.altKey && activeView !== "sequence" && activeView !== "capsule" && !isTextEntryTarget(event.target)) {
        const active = momentShortcutRef.current;
        if (active?.project && active.track && active.durationMs > 0) {
          event.preventDefault();
          void createMoment(active.project, active.track, active.timeMs);
          return;
        }
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
  }, [activeView, displayProject?.id, displayTrack?.id, playbackState, durationMs, playingProjectId, playingTrackId, showWelcome]);

  useEffect(() => {
    window.localStorage.setItem(SORT_STORAGE_KEY, sortMode);
  }, [sortMode]);

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
    if (noteStoreRef.current.getJournalError()) {
      setNoteStatus("error");
      setError("OPAL couldn’t keep a local recovery copy of this draft. Keep the window open while it saves.");
    } else {
      setNoteStatus("saving");
    }
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
    getCurrentWindow().onCloseRequested((event) => {
      event.preventDefault();
      if (closeInProgressRef.current) return;
      closeInProgressRef.current = true;
      void (async () => {
        let saveTimeout;
        const notesSaved = await Promise.race([
          flushNoteSave(),
          new Promise((resolve) => { saveTimeout = setTimeout(() => resolve(false), 5000); }),
        ]);
        clearTimeout(saveTimeout);
        const pendingDrafts = noteStoreRef.current.entries();
        const hasUnsavedDraftsWithoutRecovery = pendingDrafts.length > 0
          && Boolean(noteStoreRef.current.getJournalError());
        if (!notesSaved && hasUnsavedDraftsWithoutRecovery) {
          setError("OPAL couldn’t save this note or keep a recovery copy. Leave the app open and retry the save before closing.");
          closeInProgressRef.current = false;
          return;
        }

        // Closing OPAL's only window should quit the app on every desktop OS.
        await exit(0);
      })().catch((closeError) => {
        closeInProgressRef.current = false;
        setError(`OPAL couldn’t close cleanly: ${String(closeError)}`);
      });
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
    if (!isTauri()) return true;
    try {
      await noteStoreRef.current.flush(persistNote);
      return true;
    } catch (saveError) {
      const current = noteContextRef.current;
      if (current.key && noteStoreRef.current.get(current.key) !== undefined) {
        setNoteStatus("error");
        setError(String(saveError));
      }
      return false;
    }
  }

  async function openProject(projectId = selectedId, trackId = "", noteTrackId = null) {
    if (!projectId || !projects.some((project) => project.id === projectId)) return;
    if (!(await flushNoteSave())) return;
    setSelectedId(projectId);
    setFocusedTrackId(trackId);
    setNoteTargetId(noteTrackId);
    setActiveView("project");
  }

  async function returnToLibrary() {
    if (!(await flushNoteSave())) return;
    setActiveView("library");
    setFocusedTrackId("");
  }

  async function openProjectsView() {
    if (!(await flushNoteSave())) return;
    setActiveView("projects");
  }

  async function selectLibraryProject(projectId) {
    if (!(await flushNoteSave())) return;
    setSelectedId(projectId);
  }

  async function stepLibrarySelection(step) {
    if (!filteredProjects.length || !(await flushNoteSave())) return;
    setSelectedId((currentId) => {
      const current = Math.max(0, filteredProjects.findIndex((project) => project.id === currentId));
      const next = (current + step + filteredProjects.length) % filteredProjects.length;
      return filteredProjects[next].id;
    });
  }

  async function changeNoteTarget(trackId) {
    if (!(await flushNoteSave())) return;
    setNoteTargetId(trackId);
  }

  function handleNoteChange(nextText) {
    noteTextRef.current = nextText;
    setNoteText(nextText);
    if (noteContextKey && isTauri()) {
      noteContextRef.current = { ...noteContextRef.current, draftText: nextText };
      noteRevisionRef.current += 1;
      noteStoreRef.current.edit(noteContextKey, nextText);
      if (noteStoreRef.current.getJournalError()) {
        setNoteStatus("error");
        setError("OPAL couldn’t keep a local recovery copy of this draft. Keep the window open while it saves.");
      } else {
        setNoteStatus("saving");
      }
    }
  }

  function handleWindowMouseDown(event) {
    if (!isTauri() || event.button !== 0) return;
    if (event.target?.closest?.("button, input, textarea, label, select, a, [data-popover]")) return;
    getCurrentWindow().startDragging().catch(() => {});
  }

  function clearPlaybackGapTimer() {
    const active = playbackRef.current;
    if (active.gapTimer) window.clearTimeout(active.gapTimer);
    playbackRef.current = { ...active, gapTimer: null, gapEndsAt: null, gapRemainingMs: 0 };
  }

  function continueSequenceAfterGap(expectedRequestId) {
    if (!isCurrentPlaybackRequest(expectedRequestId, playbackRef.current.requestId)) return;
    const active = playbackRef.current;
    const nextIndex = repeatQueueIndex(active.index, active.queue.length, repeatRef.current);
    const nextTrack = nextIndex === null ? null : active.queue[nextIndex];
    if (nextTrack && nextIndex !== null) {
      startPlayback(active.project, nextTrack, nextIndex, active.queue, 0, true, true);
    } else {
      clearPlaybackGapTimer();
      setPlaybackState("ended");
      setPlaybackError("");
    }
  }

  function scheduleSequenceGap(remainingMs, expectedRequestId = playbackRef.current.requestId) {
    const delay = Math.max(0, Math.round(remainingMs));
    if (!delay) {
      continueSequenceAfterGap(expectedRequestId);
      return;
    }
    const active = playbackRef.current;
    if (!isCurrentPlaybackRequest(expectedRequestId, active.requestId)) return;
    const gapEndsAt = Date.now() + delay;
    const gapTimer = window.setTimeout(() => continueSequenceAfterGap(expectedRequestId), delay);
    playbackRef.current = { ...active, gapTimer, gapEndsAt, gapRemainingMs: delay };
    setPlaybackState("transition");
  }

  function pauseSequenceGap() {
    const active = playbackRef.current;
    if (!active.gapTimer) return;
    const gapRemainingMs = remainingGapMilliseconds(active.gapEndsAt);
    window.clearTimeout(active.gapTimer);
    playbackRef.current = { ...active, gapTimer: null, gapEndsAt: null, gapRemainingMs };
    setPlaybackState("transition-paused");
  }

  function startPlayback(project, track, index = -1, queueOverride = null, startAtMs = 0, autoplay = true, sequenceMode = playbackRef.current.sequenceMode) {
    const audio = audioRef.current;
    clearPlaybackGapTimer();
    const requestId = playbackRef.current.requestId + 1;
    const baseQueue = playbackTracks(project, track.id);
    const queue = queueOverride ?? (shuffleRef.current ? shuffleQueue(baseQueue, track.id, project.id) : baseQueue);
    const queueIndex = index >= 0 ? index : queue.findIndex((item) => item.id === track.id);
    playbackRef.current = { requestId, project, projectId: project.id, trackId: track.id, queue, index: queueIndex, sequenceMode, pendingSeekMs: startAtMs, gapTimer: null, gapEndsAt: null, gapRemainingMs: 0 };
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
        const pendingSeekMs = playbackRef.current.pendingSeekMs;
        if (pendingSeekMs > 0) {
          const nextElapsed = Math.min(pendingSeekMs, nextDuration);
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
          scheduleSequenceGap(gapMs, playbackRef.current.requestId);
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
      setPlaybackError(playbackErrorMessage({ code: audio.error?.code, format: track.format }));
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
    }).catch((playError) => {
      if (isCurrentPlaybackRequest(requestId, playbackRef.current.requestId)) {
        setPlaybackState("error");
        setPlaybackError(playbackErrorMessage({ code: audio.error?.code, rejectionName: playError?.name, format: track.format }));
      }
    });
  }

  function stopPlayback() {
    const audio = audioRef.current;
    clearPlaybackGapTimer();
    playbackRef.current = { ...playbackRef.current, requestId: playbackRef.current.requestId + 1, project: null, projectId: "", trackId: "", queue: [], index: -1, sequenceMode: false, gapTimer: null, gapEndsAt: null, gapRemainingMs: 0 };
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

  function removeMoment(project, moment) {
    if (!isTauri()) {
      setError("Open the native OPAL app to edit listening moments.");
      return;
    }
    const isCapsuleResponse = moment.lineageId?.startsWith("capsule-response:");
    setConfirmState({
      title: "Remove moment",
      message: isCapsuleResponse
        ? `Remove the moment at ${formatTime(moment.timeMs)}? This also removes its response from the local Capsule.`
        : `Remove the moment at ${formatTime(moment.timeMs)} from this version? It will disappear from the list and waveform.`,
      confirmLabel: "Remove moment",
      destructive: true,
      onConfirm: async () => {
        try {
          const updated = hydrateProject(await invoke("deleteMoment", {
            projectId: project.id,
            momentId: moment.id,
          }));
          applyProjectUpdate(updated);
          setSelectedMomentId((current) => current === moment.id ? "" : current);
          setError("");
          return true;
        } catch (momentError) {
          setError(String(momentError));
          return false;
        }
      },
    });
  }

  function selectMoment(project, track, moment) {
    setSelectedMomentId(moment.id);
    if (project.id !== selectedId || activeView !== "project") {
      void openProject(project.id, track.id, track.id);
    } else {
      setFocusedTrackId(track.id);
      void changeNoteTarget(track.id);
    }
  }

  async function toggleNotes() {
    if (!(await flushNoteSave())) return;
    setNotesOpen((openState) => !openState);
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
    if (!(await flushNoteSave())) return;
    setSelectedId(project.id);
    setActiveView("sequence");
  }

  async function leaveSequenceRoom() {
    if (!(await flushNoteSave())) return;
    setActiveView("project");
  }

  async function openCapsuleBuilder(project) {
    if (!(await flushNoteSave())) return;
    setSelectedId(project.id);
    setCapsuleCreateOpen(true);
  }

  async function openCapsuleSummary(summary, password = null) {
    if (summary.isExpired) {
      setCapsuleUnlockTarget(null);
      setError("This local Capsule has expired and can no longer be opened.");
      return false;
    }
    if (summary.missingVersionCount > 0) {
      setCapsuleUnlockTarget(null);
      setError(`This Capsule refers to ${summary.missingVersionCount} version${summary.missingVersionCount === 1 ? "" : "s"} that are no longer in the project.`);
      return false;
    }
    try {
      const opened = hydrateCapsule(await invoke("getCapsule", { capsuleId: summary.id, password }));
      capsulePasswordRef.current = password || "";
      setCapsule(opened);
      setSelectedId(summary.projectId);
      setCapsuleUnlockTarget(null);
      setCapsuleUnlockError("");
      setCapsuleResponseOpen(false);
      setActiveView("capsule");
      setError("");
      return true;
    } catch (capsuleError) {
      const message = String(capsuleError);
      if (summary.hasPassword && (message.includes("needs its password") || message.includes("password"))) {
        setCapsuleUnlockTarget(summary);
        setCapsuleUnlockError(password ? "That password didn’t unlock this Capsule. Try again." : "Enter the password used for this local Capsule.");
      } else {
        setCapsuleUnlockTarget(null);
        setError(message);
      }
      return false;
    }
  }

  function requestOpenCapsule(summary) {
    if (summary.hasPassword) {
      if (summary.isExpired) {
        setError("This local Capsule has expired and can no longer be opened.");
        return;
      }
      if (summary.missingVersionCount > 0) {
        setError(`This Capsule refers to ${summary.missingVersionCount} version${summary.missingVersionCount === 1 ? "" : "s"} that are no longer in the project.`);
        return;
      }
      setCapsuleUnlockError("");
      setCapsuleUnlockTarget(summary);
      return;
    }
    void openCapsuleSummary(summary);
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
      setNotice("Local Capsule ready. Its responses will return to your decision trail.");
      setError("");
    } catch (capsuleError) {
      setError(String(capsuleError));
    }
  }

  async function leaveCapsuleView() {
    if (!(await flushNoteSave())) return;
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
      setNotice("Local reference copied. It only opens in OPAL on this computer.");
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

  async function switchVersion(project, version) {
    if (!(await flushNoteSave())) return;
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
      pauseSequenceGap();
      return;
    }
    if (playbackState === "transition-paused") {
      scheduleSequenceGap(playbackRef.current.gapRemainingMs, playbackRef.current.requestId);
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
      }).catch((playError) => {
        if (!isCurrentPlaybackRequest(requestId, playbackRef.current.requestId)) return;
        setPlaybackState("error");
        setPlaybackError(playbackErrorMessage({ code: audio.error?.code, rejectionName: playError?.name, format: displayTrack.format }));
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
      clearPlaybackGapTimer();
      audioRef.current?.pause();
      setPlaybackState("ended");
    }
  }

  function playPrevious() {
    const current = playbackRef.current;
    const audio = audioRef.current;
    if (current.gapTimer || playbackState === "transition-paused") {
      const previousIndex = Math.max(0, current.index - 1);
      if (current.project && current.queue[previousIndex]) startPlayback(current.project, current.queue[previousIndex], previousIndex, current.queue, 0, true, current.sequenceMode);
      return;
    }
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
    if (audio.readyState === 0) {
      playbackRef.current.pendingSeekMs = nextElapsed;
    } else {
      audio.currentTime = nextElapsed / 1000;
    }
    setElapsedMs(nextElapsed);
  }

  function seekPlayer(event) {
    if (!playbackRef.current.trackId && displayProject && displayTrack?.durationMs) {
      const startAtMs = (Number(event.target.value) / 100) * displayTrack.durationMs;
      startPlayback(displayProject, displayTrack, -1, null, startAtMs, false, false);
      return;
    }
    seekPlayback(event);
  }

  async function createProject(title, description) {
    if (!isTauri()) {
      setError("Open the native OPAL app to edit the local library.");
      return;
    }
    if (!(await flushNoteSave())) return;
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
    if (!(await flushNoteSave())) return;
    let impact;
    try {
      impact = await invoke("getDeletionImpact", { projectId: project.id, trackId: version.id });
    } catch (impactError) {
      setError(String(impactError));
      return;
    }
    const wasPlaying = playingProjectId === project.id && playingTrackId === version.id;
    setConfirmState({
      title: "Remove version",
      message: `Remove “${version.versionName}” from “${group.title}”?${capsuleDeletionWarning(impact)} The OPAL-managed copy will be deleted. Your original file stays untouched.`,
      confirmLabel: "Remove version",
      destructive: true,
      onConfirm: async () => {
        if (!(await flushNoteSave())) return false;
        try {
          if (wasPlaying) stopPlayback();
          const updated = hydrateProject(await invoke("deleteTrackVersion", { projectId: project.id, trackId: version.id }));
          setProjects((current) => current.map((item) => item.id === updated.id ? updated : item));
          if (!wasPlaying) updatePlayingQueue(updated);
          noteStoreRef.current.remove(`${project.id}:${version.id}`);
          if (noteTargetId === version.id) setNoteTargetId(null);
          setError("");
          return true;
        } catch (removeError) {
          setError(String(removeError));
          return false;
        }
      },
    });
  }

  async function removeProject(project) {
    if (!isTauri()) {
      setError("Open the native OPAL app to edit the local library.");
      return;
    }
    if (!(await flushNoteSave())) return;
    let impact;
    try {
      impact = await invoke("getDeletionImpact", { projectId: project.id, trackId: null });
    } catch (impactError) {
      setError(String(impactError));
      return;
    }
    setConfirmState({
      title: "Delete project",
      message: `Delete “${project.title}”?${capsuleDeletionWarning(impact)} Its OPAL-managed audio and artwork copies will be deleted. Your original files stay untouched.`,
      confirmLabel: "Delete project",
      destructive: true,
      onConfirm: async () => {
        return await removeProjectConfirmed(project);
      },
    });
  }

  async function removeProjectConfirmed(project) {
    if (!(await flushNoteSave())) return false;
    try {
      if (playingProjectId === project.id) stopPlayback();
      await invoke("deleteProject", { projectId: project.id });
      noteStoreRef.current.removePrefix(`${project.id}:`);
      setSelectedId("");
      setActiveView("library");
      await reloadProjects("");
      setError("");
      return true;
    } catch (removeError) {
      setError(String(removeError));
      return false;
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

  async function openProfile() {
    const shouldOpen = !profileOpen;
    setProfileOpen(shouldOpen);
    if (shouldOpen) void refreshStorageInfo();
  }

  async function checkForUpdates() {
    if (!isTauri() || import.meta.env.DEV || import.meta.env.VITE_OPAL_DEVELOPMENT === "1") {
      setUpdateError("Updates are available in the installed OPAL alpha builds.");
      return;
    }
    setUpdateStatus("checking");
    setUpdateError("");
    try {
      const update = await check();
      setAvailableUpdate(update);
      setUpdateStatus(update ? "available" : "current");
    } catch (checkError) {
      setUpdateStatus("error");
      setUpdateError(String(checkError));
    }
  }

  async function installAvailableUpdate() {
    if (!availableUpdate) return;
    if (importActiveProjectsRef.current.size || libraryOperation) {
      setUpdateStatus("waiting");
      setUpdateError("Finish the current import, backup, or restore before installing the update.");
      return;
    }
    if (!(await flushNoteSave())) {
      setUpdateStatus("error");
      setUpdateError("OPAL couldn’t save your latest note. Keep OPAL open and retry the save before updating.");
      return;
    }
    setUpdateStatus("downloading");
    setUpdateError("");
    setUpdateProgress({ received: 0, total: 0 });
    try {
      await availableUpdate.downloadAndInstall((event) => {
        if (event.event === "Started") {
          setUpdateProgress({ received: 0, total: event.data.contentLength ?? 0 });
          setUpdateStatus("downloading");
        } else if (event.event === "Progress") {
          setUpdateProgress((current) => ({ ...current, received: current.received + event.data.chunkLength }));
          setUpdateStatus("downloading");
        } else if (event.event === "Finished") {
          setUpdateStatus("installing");
        }
      });
      setUpdateStatus("installed");
      await relaunch();
    } catch (installError) {
      setUpdateStatus("error");
      setUpdateError(String(installError));
    }
  }

  function openUpdates() {
    setUpdateOpen(true);
    setUpdateError("");
    if (!availableUpdate && updateStatus !== "checking") void checkForUpdates();
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
    setLibraryOperation("backup");
    try {
      const backupPath = await invoke("exportBackup", { destination });
      setNotice(`Backup exported to ${backupPath}`);
      setError("");
      await refreshStorageInfo();
    } catch (backupError) {
      setError(String(backupError));
    } finally {
      setLibraryOperation("");
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
        setLibraryOperation("restore");
        try {
          await invoke("restoreBackup", { sourcePath });
          setRecoveryMode(false);
          await reloadProjects("");
          setProfileOpen(false);
          setError("");
        } catch (restoreError) {
          if (isCompatibilityError(restoreError)) {
            setCompatibilityMode(true);
            setRecoveryMode(false);
            setError(compatibilityMessage(restoreError));
            return true;
          }
          setError(String(restoreError));
          return false;
        } finally {
          setLibraryOperation("");
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
      setDiagnosticsNotice("");
      setDiagnosticsOpen(true);
      setProfileOpen(false);
    } catch (diagnosticsError) {
      setError(String(diagnosticsError));
    }
  }

  async function copyDiagnostics() {
    try {
      await navigator.clipboard.writeText(serializeDiagnosticsReport(diagnostics));
      setDiagnosticsNotice("Diagnostics copied. Review the report before sharing it.");
    } catch {
      setDiagnosticsNotice("Clipboard access is unavailable. Use Export JSON instead.");
    }
  }

  async function exportDiagnostics() {
    const destination = await save({
      defaultPath: `OPAL-Diagnostics-${APP_VERSION}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (typeof destination !== "string") return;
    try {
      const fileName = await invoke("exportDiagnostics", { destination });
      setDiagnosticsNotice(`Saved ${fileName}. Review it before sharing.`);
    } catch {
      setDiagnosticsNotice("OPAL could not save the diagnostics report at that location.");
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

  function dismissWelcome() {
    setWelcomeOpen(false);
    try {
      localStorage.setItem(WELCOME_STORAGE_KEY, "seen");
    } catch {
      // The current session can continue even if the preference cannot be saved.
    }
  }

  const visibleSelection = filteredProjects.find((project) => project.id === selectedId)?.id ?? filteredProjects[0]?.id ?? "";
  const topbarImportProject = activeView === "library"
    ? filteredProjects.find((project) => project.id === visibleSelection) ?? null
    : activeView === "projects" ? null : selectedProject;

  return <div className="opal-app" data-view={activeView}>
    <div className="ambient-field" aria-hidden="true" />
    <header className="topbar" data-tauri-drag-region="deep" onMouseDown={handleWindowMouseDown}>
      <div className="topbar-left"><button className="brand-lockup" type="button" onClick={returnToLibrary} aria-label="Open OPAL library"><img className="brand-mark" src="/opal-mark.png" alt="" /><span className="brand-name">OPAL</span></button>{(import.meta.env.DEV || import.meta.env.VITE_OPAL_DEVELOPMENT === "1") && <span className="development-badge">Development</span>}<label className="search-field"><MagnifyingGlass size={14} weight="regular" /><input ref={searchInputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search" />{query && <button type="button" className="clear-search" onClick={() => setQuery("")} aria-label="Clear search"><X size={13} /></button>}</label></div>
      <nav className="top-navigation" aria-label="Primary navigation"><button type="button" className={activeView === "library" ? "is-active" : ""} aria-current={activeView === "library" ? "page" : undefined} onClick={returnToLibrary}>Library</button><button type="button" className={activeView === "projects" ? "is-active" : ""} aria-current={activeView === "projects" ? "page" : undefined} onClick={openProjectsView}>Projects</button></nav>
      <div className="topbar-actions">{activeView === "library" && <label className="sort-control topbar-sort-control"><span>Sort</span><select value={sortMode} onChange={(event) => setSortMode(event.target.value)} aria-label="Sort projects"><option value="updated">Recently updated</option><option value="newest">Newest</option><option value="alphabetical">A–Z</option></select><CaretDown size={13} /></label>}<button type="button" className={`topbar-import ${importActive ? "is-busy" : ""}`} aria-label={importActive ? "Show import progress" : topbarImportProject ? `Import audio into ${topbarImportProject.title}` : "Create a new project"} onClick={() => importActive ? setImportOpen(true) : (topbarImportProject ? pickAudioFiles(topbarImportProject.id) : setCreateOpen(true))}><Plus size={14} />{importActive ? "Importing…" : topbarImportProject ? "Import audio" : "New project"}</button><button type="button" className="profile-button" onClick={openProfile} aria-label="Open OPAL settings" aria-expanded={profileOpen} title="Settings"><GearSix size={17} aria-hidden="true" /></button>{profileOpen && <ProfilePopover nativeAvailable={isTauri()} storageInfo={storageInfo} storageError={storageError} importProgress={importProgress} updateStatus={updateStatus} updateAvailable={Boolean(availableUpdate)} onCheckUpdates={checkForUpdates} onOpenUpdates={openUpdates} onPreviewUpdateBanner={(import.meta.env.DEV || import.meta.env.VITE_OPAL_DEVELOPMENT === "1") ? () => {
        setProfileOpen(false);
        setUpdateBannerPreview((current) => current + 1);
      } : undefined} onRevealFolder={revealStorageFolder} onExportBackup={exportLibraryBackup} onRestoreBackup={restoreLibraryBackup} onRetryStorage={refreshStorageInfo} onDiagnostics={openDiagnostics} onReplayWelcome={() => { setProfileOpen(false); setWelcomeOpen(true); }} onClose={() => setProfileOpen(false)} />}</div>
    </header>
    {error && <div className="error-banner" role="alert"><span>{error}</span><button type="button" onClick={() => setError("")} aria-label="Dismiss message"><X size={14} /></button></div>}
    {notice && <div className="notice-banner" role="status"><span>{notice}</span><button type="button" onClick={() => setNotice("")} aria-label="Dismiss message"><X size={14} /></button></div>}
    {!updateOpen && (availableUpdate || showUpdateBannerPreview) && (
      <button
        key={showUpdateBannerPreview ? `update-preview-${updateBannerPreview}` : "available-update"}
        type="button"
        className="update-available-banner"
        onClick={showUpdateBannerPreview ? () => setUpdateBannerPreview(0) : openUpdates}
        title={showUpdateBannerPreview ? "Dismiss the update banner preview" : undefined}
      >
        <CloudCheck size={15} />
        {showUpdateBannerPreview ? "Demo · OPAL 0.1.0-alpha.5 is ready" : `OPAL ${availableUpdate.version} is ready`}
        <ArrowUpRight size={14} />
      </button>
    )}
    <main className="stage">{compatibilityMode ? <CompatibilityView onRevealFolder={revealStorageFolder} /> : recoveryMode ? <RecoveryView onRevealFolder={revealStorageFolder} onRestore={restoreLibraryBackup} onRetry={retryStorage} /> : activeView === "project" && selectedProject ? <ProjectView project={selectedProject} capsules={capsuleSummaries} capsulesLoading={capsuleShelfLoading} onOpenCapsule={requestOpenCapsule} playingTrackId={playingProjectId === selectedProject.id ? playingTrackId : ""} focusedTrackId={focusedTrackId} selectedMomentId={selectedMomentId} notesOpen={notesOpen} noteTargetId={noteTargetId} noteText={noteText} noteStatus={noteStatus} nativeAvailable={isTauri()} onBack={returnToLibrary} onTrackSelect={(track) => startPlayback(selectedProject, track)} onVersionSelect={switchVersion} onMomentSelect={selectMoment} onMomentJump={jumpToMoment} onMomentUpdate={updateMoment} onMomentDelete={removeMoment} onJumpUnresolved={jumpUnresolved} onPlay={() => currentVersions(selectedProject)[0] && startPlayback(selectedProject, currentVersions(selectedProject)[0], 0)} onOpenSequence={() => openSequenceRoom(selectedProject)} onCreateCapsule={() => openCapsuleBuilder(selectedProject)} onToggleNotes={toggleNotes} onNoteChange={handleNoteChange} onFlushNotes={flushNoteSave} onNoteTargetChange={changeNoteTarget} onImport={() => pickAudioFiles(selectedProject.id)} onAddVersion={(group) => pickAudioFiles(selectedProject.id, group.id)} onEditProject={() => setEditOpen(true)} onEditArtwork={pickArtwork} onRemoveArtwork={removeArtwork} onRemoveProject={() => removeProject(selectedProject)} onRenameTrack={renameTrack} onRenameVersion={renameVersion} onPromoteVersion={promoteVersion} onReorderGroups={reorderTrackGroups} onReorderVersions={reorderTrackVersions} onRemoveVersion={(version, group) => removeVersion(selectedProject, version, group)} /> : activeView === "sequence" && selectedProject ? <SequenceRoom project={selectedProject} playingTrackId={playingProjectId === selectedProject.id ? playingTrackId : ""} playbackState={playbackState} elapsedMs={elapsedMs} durationMs={durationMs || displayTrack?.durationMs || 0} onBack={leaveSequenceRoom} onPlayTrack={playSequenceTrack} onAuditionTransition={auditionTransition} onReorderGroups={reorderTrackGroups} onUpdateTransition={updateTransition} onPlay={() => toggleSequencePlayback(selectedProject)} onPrevious={playPrevious} onNext={playNext} onProgressChange={seekPlayback} onCreateCapsule={() => openCapsuleBuilder(selectedProject)} /> : activeView === "capsule" && selectedProject && capsule ? <CapsuleView capsule={capsule} project={selectedProject} playingTrackId={playingProjectId === selectedProject.id ? playingTrackId : ""} playbackState={playbackState} elapsedMs={elapsedMs} durationMs={durationMs || displayTrack?.durationMs || 0} onBack={leaveCapsuleView} onPlayTrack={playCapsuleTrack} onPlay={() => toggleCapsulePlayback(capsule)} onPrevious={playPrevious} onNext={playNext} onProgressChange={seekPlayback} onCopyReference={() => copyCapsuleReference(capsule)} onOpenResponse={() => setCapsuleResponseOpen(true)} onAddResponse={addCapsuleResponse} /> : activeView === "projects" ? <ProjectsView loading={loading} projects={filteredProjects} query={query} sortMode={sortMode} onSortChange={setSortMode} onOpenProject={openProject} onPlayProject={(project) => currentVersions(project)[0] && startPlayback(project, currentVersions(project)[0], 0)} onCreateProject={() => setCreateOpen(true)} onClearSearch={() => setQuery("")} /> : <LibraryView loading={loading} projects={filteredProjects} selectedId={visibleSelection} query={query} sortMode={sortMode} trackMatches={trackMatches} onSortChange={setSortMode} onProjectSelect={selectLibraryProject} onOpenProject={openProject} onCreateProject={() => setCreateOpen(true)} onClearSearch={() => setQuery("")} onStep={stepLibrarySelection} />}</main>
    {activeView !== "sequence" && activeView !== "capsule" && displayProject && displayTrack && <Player project={displayProject} track={displayTrack} selectedMomentId={selectedMomentId} status={playbackState} playbackError={playbackError} isPlaying={playbackState === "playing"} progress={progressValue} elapsedMs={elapsedMs} durationMs={durationMs || displayTrack.durationMs} volume={volume} muted={muted} volumeOpen={volumeOpen} queueOpen={queueOpen} menuOpen={playerMenuOpen} shuffleEnabled={shuffleEnabled} repeatMode={repeatMode} onTogglePlay={togglePlayback} onPrevious={playPrevious} onNext={playNext} onProgressChange={seekPlayer} onCreateMoment={(timeMs) => createMoment(displayProject, displayTrack, timeMs)} onSelectMoment={(moment) => selectMoment(displayProject, displayTrack, moment)} onVolumeChange={(event) => { setVolume(Number(event.target.value)); setMuted(false); }} onToggleMute={() => setMuted((value) => !value)} onToggleVolume={() => setVolumeOpen((openState) => !openState)} onToggleQueue={() => setQueueOpen((openState) => !openState)} onToggleMenu={() => setPlayerMenuOpen((openState) => !openState)} onToggleShuffle={toggleShuffle} onToggleRepeat={cycleRepeatMode} onOpenProject={() => openProject(displayProject.id)} onShowTrack={() => openProject(displayProject.id, displayTrack.id)} onOpenNotes={() => openProject(displayProject.id, displayTrack.id, displayTrack.id)} onRevealFile={async () => { try { await invoke("revealManagedFile", { managedFileRef: displayTrack.managedFileRef }); } catch (revealError) { setError(String(revealError)); } }} onShowInfo={() => setTrackInfo({ project: displayProject, track: displayTrack })} />}
    {activeView !== "sequence" && activeView !== "capsule" && queueOpen && displayProject && <QueuePopover project={displayProject} currentIndex={displayQueueIndex} onSelect={(track, index) => { startPlayback(displayProject, track, index); setQueueOpen(false); }} onClose={() => setQueueOpen(false)} />}
    {showWelcome && (
      <DialogFrame
        titleId="welcome-title"
        onClose={dismissWelcome}
        className="onboarding-dialog"
        backdrop={<OnboardingAmbient />}
        dismissOnBackdrop={false}
      >
        <Onboarding onClose={dismissWelcome} onEnter={() => { dismissWelcome(); void returnToLibrary(); }} />
      </DialogFrame>
    )}
    {updateOpen && <UpdateDialog update={availableUpdate} appVersion={APP_VERSION} status={updateStatus} progress={updateProgress} error={updateError} busy={Boolean(importActive || libraryOperation)} onCheck={checkForUpdates} onInstall={installAvailableUpdate} onClose={() => setUpdateOpen(false)} />}
    {createOpen && <CreateProjectPrompt onClose={() => setCreateOpen(false)} onCreate={createProject} />}
    {editOpen && selectedProject && <ProjectEditorPrompt project={selectedProject} onClose={() => setEditOpen(false)} onSave={updateProject} />}
    {importOpen && importProject && <ImportPrompt project={importProject} groupTitle={importTargetGroup?.title} progress={importProgress} duplicatePaths={duplicatePaths} onClose={closeImport} onChooseFiles={() => pickAudioFiles(importProject.id, importTargetGroupId)} onRetryImport={() => { const request = lastImportRequestRef.current; if (request) runImport(request.projectId, request.paths, request.allowDuplicates, request.groupId); }} onImportDuplicates={() => runImport(importProject.id, duplicatePaths, true, importTargetGroupId)} onSkipDuplicates={() => { setDuplicatePaths([]); setImportProgress((current) => ({ ...(current ?? {}), status: "complete", message: "Duplicates skipped." })); }} />}
    {capsuleCreateOpen && selectedProject && <CreateCapsulePrompt project={selectedProject} onClose={() => setCapsuleCreateOpen(false)} onCreate={(options) => createCapsule(selectedProject, options)} />}
    {capsuleUnlockTarget && <CapsuleUnlockPrompt summary={capsuleUnlockTarget} error={capsuleUnlockError} onClose={() => { setCapsuleUnlockTarget(null); setCapsuleUnlockError(""); }} onSubmit={(password) => openCapsuleSummary(capsuleUnlockTarget, password)} />}
    {capsuleResponseOpen && capsule && <CapsuleResponsePrompt capsule={capsule} currentTrack={selectedProject?.tracks.find((track) => track.id === playingTrackId) ?? capsule.tracks[0]} timeMs={playingProjectId === selectedProject?.id ? elapsedMs : 0} onClose={() => setCapsuleResponseOpen(false)} onSend={addCapsuleResponse} />}
    {trackInfo && <TrackInfoDialog project={trackInfo.project} track={trackInfo.track} onClose={() => setTrackInfo(null)} />}
    {diagnosticsOpen && <DiagnosticsDialog diagnostics={diagnostics} notice={diagnosticsNotice} onCopy={copyDiagnostics} onExport={exportDiagnostics} onClose={() => setDiagnosticsOpen(false)} />}
    {confirmState && <ConfirmDialog {...confirmState} busy={confirmBusy} onClose={() => { if (!confirmBusy) setConfirmState(null); }} onConfirm={async () => { if (confirmBusy) return; const action = confirmState.onConfirm; setConfirmBusy(true); try { if ((await action()) !== false) setConfirmState(null); } finally { setConfirmBusy(false); } }} />}
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

function LibraryView({ loading, projects: visibleProjects, selectedId, query, sortMode, trackMatches, onSortChange, onOpenProject, onCreateProject, onClearSearch, onStep }) {
  if (loading) return <section className="library-screen view-stack loading-library"><div className="library-loading glass"><CircleNotch size={23} weight="thin" /></div></section>;
  if (!visibleProjects.length) {
    const hasSearch = Boolean(query.trim());
    return <section className="library-screen view-stack empty-library-screen" aria-labelledby="empty-library-title"><div className="empty-library glass"><div className="empty-library-art" aria-hidden="true"><span className="empty-library-orb" /><span className="empty-library-orbit" /></div><span className="eyebrow">{hasSearch ? "Library search" : "Your listening room"}</span><h1 id="empty-library-title">{hasSearch ? "Nothing found" : <>A home for every <em>version.</em></>}</h1><p>{hasSearch ? <>No project matches “{query}”. Clear your search to see the full collection.</> : "Keep each track, its alternate takes, listening notes, and the moments you want to return to together."}</p><div className="empty-library-actions"><button className="button button-primary" type="button" onClick={hasSearch ? onClearSearch : onCreateProject}>{hasSearch ? "Clear search" : "Create a project"}<ArrowUpRight size={14} /></button></div></div></section>;
  }
  return <ProjectCarousel
    key={JSON.stringify(visibleProjects.map((project) => project.id))}
    projects={visibleProjects}
    selectedId={selectedId}
    trackMatches={trackMatches}
    onOpenProject={onOpenProject}
    onStep={onStep}
  />;
}

function ProjectCarousel({ projects, selectedId, trackMatches, onOpenProject, onStep }) {
  const count = projects.length;
  const selectedIndex = Math.max(0, projects.findIndex((project) => project.id === selectedId));
  const selected = projects[selectedIndex];
  const orbitRef = useRef(null);
  const pointerRef = useRef(null);
  const suppressClickRef = useRef(false);
  const directionRef = useRef(1);
  const wheelRef = useRef({ delta: 0, lastEvent: 0, lastStep: -Infinity });
  const [position, setPosition] = useState({ index: selectedIndex, cursor: selectedIndex });
  let cursor = position.cursor;
  if (selectedIndex !== position.index) {
    let delta = selectedIndex - position.index;
    if (Math.abs(delta) > count / 2) delta -= Math.sign(delta) * count;
    if (Math.abs(delta) === count / 2) delta = directionRef.current * Math.abs(delta);
    cursor += delta;
    setPosition({ index: selectedIndex, cursor });
  }

  const visibleRadius = count >= 4 ? 2 : count >= 2 ? 1 : 0;
  const radius = visibleRadius ? visibleRadius + 1 : 0;
  // Absolute occurrence keys let a sleeve keep its artwork as it moves through the loop.
  const cards = Array.from({ length: 2 * radius + 1 }, (_, i) => {
    const offset = i - radius;
    const slot = cursor + offset;
    const index = ((slot % count) + count) % count;
    return { project: projects[index], offset, slot };
  });

  useEffect(() => {
    const orbit = orbitRef.current;
    function handleWheel(event) {
      if (count < 2 || event.ctrlKey || Math.abs(event.deltaX) <= Math.abs(event.deltaY)) return;
      event.preventDefault();
      const now = performance.now();
      const wheel = wheelRef.current;
      if (now - wheel.lastEvent > 150 || Math.sign(wheel.delta) !== Math.sign(event.deltaX)) wheel.delta = 0;
      wheel.lastEvent = now;
      if (now - wheel.lastStep < 320) return;
      wheel.delta += event.deltaX * (event.deltaMode ? 16 : 1);
      if (Math.abs(wheel.delta) < 40) return;
      directionRef.current = Math.sign(wheel.delta);
      wheel.delta = 0;
      wheel.lastStep = now;
      onStep(directionRef.current);
    }

    orbit.addEventListener("wheel", handleWheel, { passive: false });
    return () => orbit.removeEventListener("wheel", handleWheel);
  }, [count, onStep]);

  function step(direction) {
    if (count < 2) return;
    directionRef.current = direction;
    onStep(direction);
  }

  function handlePointerDown(event) {
    if (!event.isPrimary || event.button !== 0) return;
    suppressClickRef.current = false;
    if (count < 2) return;
    pointerRef.current = { id: event.pointerId, x: event.clientX, y: event.clientY, dragging: false };
  }

  function handlePointerMove(event) {
    const pointer = pointerRef.current;
    if (!pointer || event.pointerId !== pointer.id) return;
    const x = event.clientX - pointer.x;
    const y = event.clientY - pointer.y;
    if (!pointer.dragging) {
      if (Math.abs(x) < 8 || Math.abs(x) < Math.abs(y) * 1.2) return;
      pointer.dragging = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.classList.add("is-dragging");
    }
    const drag = Math.max(-125, Math.min(125, x * .7));
    event.currentTarget.style.setProperty("--drag-x", `${drag}px`);
  }

  function finishPointer(event, cancelled = false) {
    const pointer = pointerRef.current;
    if (!pointer || event.pointerId !== pointer.id) return;
    pointerRef.current = null;
    if (!pointer.dragging) return;
    suppressClickRef.current = true;
    event.currentTarget.classList.remove("is-dragging");
    event.currentTarget.style.removeProperty("--drag-x");
    const x = event.clientX - pointer.x;
    if (!cancelled && Math.abs(x) >= 48) step(x < 0 ? 1 : -1);
  }

  function openCard(project, event) {
    if (event.detail > 0 && suppressClickRef.current) return;
    onOpenProject(project.id, trackMatches.get(project.id)?.id ?? "");
  }

  return (
    <section className="library-screen view-stack" aria-label="OPAL library">
      <h1 className="library-accessible-title">Library</h1>
      <div className="carousel-wrap">
        {count > 1 && <button type="button" className="carousel-control carousel-control-left" onClick={() => step(-1)} aria-label="Previous project"><CaretLeft size={22} /></button>}
        <div
          ref={orbitRef}
          className="sleeve-orbit"
          role="group"
          tabIndex={-1}
          aria-label="Project carousel. Swipe or use the arrow keys to browse."
          onKeyDown={(event) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            event.currentTarget.focus({ preventScroll: true });
            step(event.key === "ArrowLeft" ? -1 : 1);
          }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerLeave={(event) => { if (!pointerRef.current?.dragging) finishPointer(event, true); }}
          onPointerUp={finishPointer}
          onPointerCancel={(event) => finishPointer(event, true)}
          onLostPointerCapture={(event) => finishPointer(event, true)}
        >
          {cards.map(({ project, offset, slot }) => {
            const buffered = Math.abs(offset) > visibleRadius;
            const mirror = count % 2 === 0 && offset === -count / 2;
            return (
              <button
                type="button"
                key={slot}
                className={`sleeve${offset === 0 ? " is-selected" : ""}${buffered ? " is-buffered" : ""}`}
                data-offset={offset}
                aria-current={offset === 0 || undefined}
                aria-hidden={buffered || mirror || undefined}
                tabIndex={buffered || mirror ? -1 : undefined}
                disabled={buffered}
                aria-label={`Open ${project.title} project`}
                onClick={(event) => openCard(project, event)}
              >
                <span className="sleeve-image-wrap"><img src={project.artwork} alt="" draggable="false" /></span>
                <span className="sleeve-meta">
                  <strong>{project.title}</strong>
                  <small>{(offset === 0 && project.tracks[0]?.title) || `${project.count} ${project.count === 1 ? "track" : "tracks"}`}</small>
                </span>
              </button>
            );
          })}
        </div>
        {count > 1 && <button type="button" className="carousel-control carousel-control-right" onClick={() => step(1)} aria-label="Next project"><CaretRight size={22} /></button>}
      </div>
      <div className="carousel-caption">
        <button className="caption-open" type="button" aria-label={`Open ${selected.title} project`} onClick={() => onOpenProject(selected.id, trackMatches.get(selected.id)?.id ?? "")}>
          <span>{selected.description?.trim() || `${selected.count} ${selected.count === 1 ? "track" : "tracks"} · ${selected.duration}`}</span>
          <ArrowUpRight size={16} />
        </button>
      </div>
    </section>
  );
}

function SleeveWall({ projects, selectedId, query, sortMode, trackMatches, onSortChange, onProjectSelect, onOpenProject, onCreateProject, onImport }) {
  return <section className="library-screen sleeve-wall-screen view-stack">
    <div className="library-heading-row sleeve-wall-heading"><div><span className="eyebrow">A gathered collection</span><h1>Library</h1></div><div className="sleeve-wall-actions"><label className="sort-control"><span>Sort</span><select value={sortMode} onChange={(event) => onSortChange(event.target.value)} aria-label="Sort projects"><option value="updated">Recently updated</option><option value="newest">Newest</option><option value="alphabetical">A–Z</option></select><CaretDown size={13} /></label><button className="button button-ghost" type="button" onClick={onCreateProject}><Plus size={14} />New project</button></div></div>
    <div className="sleeve-wall" aria-label="Project sleeve wall">{projects.map((project) => { const match = trackMatches.get(project.id); return <article className={`wall-sleeve ${project.id === selectedId ? "is-selected" : ""}`} key={project.id}><button className="wall-sleeve-open" type="button" onClick={() => { onProjectSelect(project.id); onOpenProject(project.id, match?.id ?? ""); }} aria-label={`Open ${project.title}`}><img src={project.artwork} alt="" /><span className="wall-sleeve-glint" aria-hidden="true" /></button><div className="wall-sleeve-meta"><strong title={project.title}>{project.title}</strong><span>{project.count} tracks <em>·</em> {project.duration}</span>{match && <small className="search-hit">Match: {match.title}</small>}</div></article>; })}<button className="wall-create-card" type="button" onClick={onCreateProject}><Plus size={22} /><strong>New project</strong><span>Keep the wall growing</span></button></div>
    <div className="sleeve-wall-footer"><span>{projects.length} projects</span><button className="rail-import" type="button" onClick={onImport}><Plus size={17} /><span>Import audio</span></button><span>{query ? `Results for “${query}”` : "Local library"}</span></div>
  </section>;
}

function CapsuleShelf({ capsules, loading, onOpen }) {
  return <section className="capsule-shelf glass" aria-label="Local capsules">
    <div className="capsule-shelf-heading"><div><h2>Capsules</h2></div><span>{capsules.length} {capsules.length === 1 ? "capsule" : "capsules"}</span></div>
    {loading ? <p className="capsule-shelf-empty" role="status">Loading local Capsules…</p> : capsules.length ? <div className="capsule-shelf-grid">{capsules.map((summary) => {
      const unavailable = summary.isExpired || summary.missingVersionCount > 0;
      const stateLabel = summary.isExpired ? "Expired" : summary.missingVersionCount ? `${summary.missingVersionCount} version${summary.missingVersionCount === 1 ? "" : "s"} unavailable` : summary.hasPassword ? "Password required" : "Local only";
      return <button className="capsule-shelf-card" key={summary.id} type="button" onClick={() => onOpen(summary)} disabled={unavailable}>
        <span className="capsule-shelf-card-top"><span className={`capsule-shelf-state ${unavailable ? "is-unavailable" : ""}`}>{summary.hasPassword && !unavailable && <LockKey size={12} />}{stateLabel}</span><span className="capsule-shelf-expiry">{summary.isExpired ? "Expired" : formatCapsuleExpiry(summary.expiresAt)}</span></span>
        <span className="capsule-shelf-card-copy"><strong>{summary.title}</strong><small>{summary.trackCount} selected {summary.trackCount === 1 ? "version" : "versions"} <span>·</span> {summary.includeNotes ? "Notes included" : "Listening only"}</small></span>
        {!unavailable && <ArrowUpRight className="capsule-shelf-open" size={14} />}
      </button>;
    })}</div> : <p className="capsule-shelf-empty">No Capsules yet. Create one from the project menu.</p>}
  </section>;
}

function ProjectArtwork({ title, artwork, nativeAvailable, onChange }) {
  return <div className="project-cover-column">
    <div className="project-sleeve-shell">
      <button className="project-sleeve-trigger" type="button" onClick={onChange} disabled={!nativeAvailable} aria-label={`Change artwork for ${title}`} title={nativeAvailable ? "Change project artwork" : "Open the native OPAL app to change artwork"}>
        <img className="project-sleeve" src={artwork} alt="" />
        <span className="project-sleeve-change"><ImageSquare size={15} />Change artwork</span>
      </button>
    </div>
  </div>;
}

function ProjectNotesPanel({ project, projectId, noteContextId, noteLabel, noteText, noteStatus, nativeAvailable, onNoteChange, onFlushNotes, momentTrack, selectedMomentId, onMomentSelect, onMomentJump, onMomentUpdate, onMomentDelete, onJumpUnresolved }) {
  const [expanded, setExpanded] = useState(false);
  const canExpand = noteText.length > 220 || noteText.split(/\r?\n/).length > 3;

  useEffect(() => setExpanded(false), [projectId, noteContextId]);

  async function closeExpandedNotes() {
    if (onFlushNotes && !(await onFlushNotes())) return;
    setExpanded(false);
  }

  return <>
    <aside className="notes-panel glass">
      <div className="notes-heading">
        <div><h2>Notes</h2><span className="notes-context">{noteLabel}</span></div>
        <span className={`notes-state is-${noteStatus}`} aria-live="polite">{noteStatus === "saving" ? "Saving" : noteStatus === "error" ? "Couldn’t save" : <><Check size={12} />Saved</>}</span>
      </div>
      <textarea key={`${projectId}:${noteContextId}`} className="notes-preview-input" rows={4} aria-label={`${noteLabel} notes`} placeholder="A thought to keep with this project…" value={noteText} onChange={(event) => onNoteChange(event.target.value)} disabled={!nativeAvailable} />
      {canExpand && <button className="notes-expand-trigger" type="button" onClick={() => setExpanded(true)} aria-expanded={expanded}>
        Show more<CaretDown size={14} />
      </button>}
      {momentTrack && <MomentList project={project} track={momentTrack} selectedMomentId={selectedMomentId} onSelectMoment={onMomentSelect} onJumpMoment={onMomentJump} onUpdateMoment={onMomentUpdate} onDeleteMoment={onMomentDelete} onJumpUnresolved={onJumpUnresolved} />}
    </aside>
    {expanded && <DialogFrame titleId="project-notes-title" onClose={closeExpandedNotes} className="notes-expand-dialog">
      <button className="modal-close" type="button" onClick={closeExpandedNotes} aria-label="Close notes"><X size={18} /></button>
      <span className="eyebrow">{noteLabel}</span>
      <h2 id="project-notes-title">Notes</h2>
      <div className="notes-expanded-heading"><span>Autosaves as you write.</span><span className={`notes-state is-${noteStatus}`} aria-live="polite">{noteStatus === "saving" ? "Saving" : noteStatus === "error" ? "Couldn’t save" : <><Check size={12} />Saved</>}</span></div>
      <textarea className="notes-expanded-input" aria-label={`${noteLabel} notes`} value={noteText} onChange={(event) => onNoteChange(event.target.value)} disabled={!nativeAvailable} autoFocus />
      <button className="button button-primary modal-cta" type="button" onClick={closeExpandedNotes}>Done</button>
    </DialogFrame>}
  </>;
}

function ProjectView({ project, capsules, capsulesLoading, onOpenCapsule, playingTrackId, focusedTrackId, selectedMomentId, notesOpen, noteTargetId, noteText, noteStatus, nativeAvailable, onBack, onTrackSelect, onVersionSelect, onMomentSelect, onMomentJump, onMomentUpdate, onMomentDelete, onJumpUnresolved, onPlay, onOpenSequence, onCreateCapsule, onToggleNotes, onNoteChange, onNoteTargetChange, onFlushNotes, onImport, onAddVersion, onEditProject, onEditArtwork, onRemoveArtwork, onRemoveProject, onRenameTrack, onRenameVersion, onPromoteVersion, onReorderGroups, onReorderVersions, onRemoveVersion }) {
  const groups = useMemo(() => groupTracks(project), [project]);
  const [editingGroupId, setEditingGroupId] = useState("");
  const [editingTitle, setEditingTitle] = useState("");
  const [draggedGroupId, setDraggedGroupId] = useState("");
  const [activeGroupId, setActiveGroupId] = useState(groups[0]?.id ?? "");
  const [trackMenuId, setTrackMenuId] = useState("");
  const [versionMenuId, setVersionMenuId] = useState("");
  const [projectActionsOpen, setProjectActionsOpen] = useState(false);
  const projectActionsRef = useRef(null);
  const projectActionsTriggerRef = useRef(null);

  useEffect(() => {
    if (!groups.some((group) => group.id === activeGroupId)) setActiveGroupId(groups[0]?.id ?? "");
  }, [groups, activeGroupId]);

  useEffect(() => {
    if (!focusedTrackId) return undefined;
    const timer = setTimeout(() => document.getElementById(`track-${focusedTrackId}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 100);
    return () => clearTimeout(timer);
  }, [focusedTrackId]);

  useEffect(() => {
    if (!projectActionsOpen) return undefined;
    function handlePointerDown(event) {
      if (!projectActionsRef.current?.contains(event.target)) setProjectActionsOpen(false);
    }
    function handleKeyDown(event) {
      if (event.key === "Escape") {
        setProjectActionsOpen(false);
        projectActionsTriggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [projectActionsOpen]);

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
  function runProjectAction(action) {
    setProjectActionsOpen(false);
    action();
  }
  return <section className="project-screen view-stack">
    <div className="project-topline"><button className="back-action" type="button" onClick={onBack}><ArrowLeft size={16} />Library</button></div>
      <div className="project-detail-layout">
      <ProjectArtwork title={project.title} artwork={project.artwork} nativeAvailable={nativeAvailable} onChange={onEditArtwork} />
      <div className="project-main-column">
        <div className="project-header"><div className="project-heading-copy"><h1>{project.title}</h1><p>{project.count} tracks <span>·</span> {project.duration} <span>·</span> {project.year}</p></div><div className="heading-actions"><button className="button button-primary project-play-button" type="button" onClick={onPlay} disabled={!project.count}><Play size={14} weight="fill" />Play</button><div className="project-action-menu-wrap" ref={projectActionsRef}><button ref={projectActionsTriggerRef} className="button button-ghost project-more-trigger" type="button" onClick={() => setProjectActionsOpen((open) => !open)} aria-expanded={projectActionsOpen} aria-controls={`project-actions-${project.id}`} aria-label="More project actions"><DotsThree size={18} /><span>More</span></button>{projectActionsOpen && <div id={`project-actions-${project.id}`} className="project-actions-menu glass" role="group" aria-label="Project actions"><button type="button" disabled={!project.count} onClick={() => runProjectAction(onOpenSequence)}><Queue size={15} />Sequence room</button><button type="button" disabled={!project.count} onClick={() => runProjectAction(onCreateCapsule)}><ShareNetwork size={15} />Make capsule</button><button type="button" onClick={() => runProjectAction(onToggleNotes)}><NotePencil size={15} />{notesOpen ? "Hide notes" : "Show notes"}</button><span className="project-actions-divider" /><button type="button" onClick={() => runProjectAction(onEditProject)}><NotePencil size={15} />Edit details</button><button type="button" onClick={() => runProjectAction(onEditArtwork)}><ImageSquare size={15} />Change artwork</button>{project.artworkRef && <button type="button" onClick={() => runProjectAction(onRemoveArtwork)}><Trash size={15} />Remove artwork</button>}<span className="project-actions-divider" /><button className="is-danger" type="button" onClick={() => runProjectAction(onRemoveProject)}><Trash size={15} />Delete project</button></div>}</div></div></div>
        {project.description && <p className="project-description project-description-inline">{project.description}</p>}
        <CapsuleShelf capsules={capsules} loading={capsulesLoading} onOpen={onOpenCapsule} />
        <div className={`project-workspace ${notesOpen ? "" : "notes-closed"}`}><div className="tracklist-panel"><div className="section-heading project-track-heading"><div className="project-section-title"><h2>Tracks</h2><span className="section-count">{project.count} {project.count === 1 ? "track" : "tracks"}</span></div><button className="project-add-tracks" type="button" onClick={onImport}><Plus size={16} />Add tracks</button></div><div className="track-list">{groups.map((group, index) => { const current = group.current; const isFocused = group.versions.some((version) => version.id === focusedTrackId); const isPlaying = group.versions.some((version) => version.id === playingTrackId); const menuOpen = trackMenuId === group.id; const ribbonOpen = activeGroupId === group.id && group.versions.length > 1; return <React.Fragment key={group.id}><div className={`track-row ${isPlaying ? "is-current" : ""} ${isFocused ? "is-search-match" : ""} ${draggedGroupId === group.id ? "is-dragging" : ""}`} id={`track-${isFocused ? focusedTrackId : group.id}`} draggable={!editingGroupId} onDragStart={() => setDraggedGroupId(group.id)} onDragEnd={() => setDraggedGroupId("")} onDragOver={(event) => event.preventDefault()} onDrop={() => dropGroup(group.id)}><div className="track-main" role="button" tabIndex={0} onClick={() => { setActiveGroupId(group.id); onTrackSelect(current); }} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setActiveGroupId(group.id); onTrackSelect(current); } }}><span className="track-number">{String(index + 1).padStart(2, "0")}</span><span className="drag-handle" aria-hidden="true"><DotsSixVertical size={14} /></span>{editingGroupId === group.id ? <input className="track-title-editor" autoFocus value={editingTitle} onChange={(event) => setEditingTitle(event.target.value)} onClick={(event) => event.stopPropagation()} onBlur={() => finishEditing(group)} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); if (event.key === "Escape") { setEditingGroupId(""); setEditingTitle(group.title); } }} /> : <span className="track-name"><strong>{group.title}</strong><small>{current?.versionName ?? "Original"}{group.versions.length > 1 ? ` · ${group.versions.length} versions` : ""}</small></span>}</div><span className="track-duration">{current?.duration ?? "0:00"}</span><div className="track-actions"><span className="track-menu-wrap"><button type="button" className={`track-action track-menu-trigger ${menuOpen ? "is-active" : ""}`} onClick={(event) => { event.stopPropagation(); setActiveGroupId(group.id); setTrackMenuId(menuOpen ? "" : group.id); }} aria-label={`Open actions for ${group.title}`} aria-expanded={menuOpen}><DotsThree size={17} /></button>{menuOpen && <TrackMenu group={group} index={index} groupCount={groups.length} onMove={(direction) => { setTrackMenuId(""); moveGroup(index, direction); }} onRename={() => { setTrackMenuId(""); startEditing(group); }} onAddVersion={() => { setTrackMenuId(""); onAddVersion(group); }} onNotes={() => { setTrackMenuId(""); onNoteTargetChange(noteTargetId === current?.id ? null : current?.id); }} onRemove={() => { setTrackMenuId(""); onRemoveVersion(current, group); }} onClose={() => setTrackMenuId("")} />}</span></div></div>{ribbonOpen && <div className="version-ribbon" aria-label={`Versions of ${group.title}`}>{group.versions.map((version, versionIndex) => <div className={`version-chip-wrap ${versionMenuId === version.id ? "is-menu-open" : ""}`} key={version.id}><button type="button" className={`version-chip ${version.isCurrent ? "is-current" : ""} ${playingTrackId === version.id ? "is-playing" : ""}`} onClick={() => onVersionSelect(project, version)} aria-pressed={version.isCurrent}><span className="version-chip-marker">{version.isCurrent ? <Check size={11} weight="bold" /> : <span>{String(versionIndex + 1).padStart(2, "0")}</span>}</span><span><strong>{version.versionName}</strong><small>{version.duration}</small></span></button><button type="button" className="version-chip-menu" onClick={() => setVersionMenuId(versionMenuId === version.id ? "" : version.id)} aria-label={`Open actions for ${version.versionName}`} aria-expanded={versionMenuId === version.id}><DotsThree size={15} /></button>{versionMenuId === version.id && <VersionMenu version={version} index={versionIndex} versionCount={group.versions.length} onMove={(direction) => { setVersionMenuId(""); moveVersion(group, versionIndex, direction); }} onRename={() => { setVersionMenuId(""); const nextName = window.prompt("Version name", version.versionName); if (nextName?.trim()) onRenameVersion(version.id, nextName); }} onPromote={() => { setVersionMenuId(""); onPromoteVersion(version); }} onNotes={() => { setVersionMenuId(""); onNoteTargetChange(noteTargetId === version.id ? null : version.id); }} onRemove={() => { setVersionMenuId(""); onRemoveVersion(version, group); }} onClose={() => setVersionMenuId("")} />}</div>)}</div>}</React.Fragment>; })}</div></div>{notesOpen && <ProjectNotesPanel
          project={project}
          projectId={project.id}
          noteContextId={noteTargetId ?? "project"}
          noteLabel={noteLabel}
          noteText={noteText}
          noteStatus={noteStatus}
          nativeAvailable={nativeAvailable}
          onNoteChange={onNoteChange}
          onFlushNotes={onFlushNotes}
          momentTrack={momentTrack}
          selectedMomentId={selectedMomentId}
          onMomentSelect={(moment) => onMomentSelect(project, momentTrack, moment)}
          onMomentJump={onMomentJump}
          onMomentUpdate={onMomentUpdate}
          onMomentDelete={onMomentDelete}
          onJumpUnresolved={(direction) => onJumpUnresolved(project, momentTrack, direction)}
        />}</div>
      </div>
    </div>
  </section>;
}

function SequenceRoom({ project, playingTrackId, playbackState, elapsedMs, durationMs, onBack, onPlayTrack, onAuditionTransition, onReorderGroups, onUpdateTransition, onPlay, onPrevious, onNext, onProgressChange, onCreateCapsule }) {
  const groups = useMemo(() => groupTracks(project), [project]);
  const tracks = groups.map((group) => group.current).filter(Boolean);
  const [draggedGroupId, setDraggedGroupId] = useState("");
  const current = tracks.find((track) => track.id === playingTrackId) ?? tracks[0] ?? null;
  const progress = durationMs > 0 ? Math.min(100, (elapsedMs / durationMs) * 100) : 0;
  const status = playbackState === "transition" ? "Between tracks" : playbackState === "transition-paused" ? "Paused" : playbackState === "playing" ? "Playing" : playbackState === "loading" ? "Loading" : playbackState === "error" ? "Unavailable" : "Ready";

  function moveGroup(targetId) {
    if (!draggedGroupId || draggedGroupId === targetId) return;
    const ids = groups.map((group) => group.id).filter((id) => id !== draggedGroupId);
    const targetIndex = ids.indexOf(targetId);
    ids.splice(targetIndex, 0, draggedGroupId);
    setDraggedGroupId("");
    onReorderGroups(ids);
  }

  if (!current) return <section className="sequence-room sequence-room-empty"><button className="back-action" type="button" onClick={onBack}><ArrowLeft size={16} />Project</button><div><span className="eyebrow">Sequence</span><h1>No tracks yet</h1><p>Add tracks to build a listening order.</p></div></section>;

  return <section className="sequence-room view-stack">
    <div className="sequence-room-topline"><button className="back-action" type="button" onClick={onBack}><ArrowLeft size={16} />Project</button><div className="sequence-room-title"><span className="eyebrow">Sequence</span><h1>{project.title}</h1></div><div className="sequence-room-actions"><button className="button button-capsule" type="button" onClick={onCreateCapsule}><ShareNetwork size={14} />Make capsule</button></div></div>
    <div className="sequence-hero">
      <div className="sequence-artwork-wrap"><img src={project.artwork} alt={`${project.title} artwork`} /></div>
      <div className="sequence-hero-copy"><span className="eyebrow">{status}</span><h2>{current.title}</h2><p>{current.versionName} <span>·</span> {current.duration}</p><div className="sequence-transport"><button type="button" onClick={onPrevious} aria-label="Previous track"><SkipBack size={17} weight="fill" /></button><button className="sequence-play" type="button" onClick={onPlay} aria-label={playbackState === "playing" ? "Pause sequence" : "Play sequence"}>{playbackState === "playing" ? <Pause size={19} weight="fill" /> : <Play size={19} weight="fill" />}</button><button type="button" onClick={onNext} aria-label="Next track"><SkipForward size={17} weight="fill" /></button></div><div className="sequence-progress"><div><span>{formatTime(elapsedMs)}</span><span>{formatTime(durationMs)}</span></div><input aria-label="Sequence playback position" type="range" min="0" max="100" value={progress} onChange={onProgressChange} disabled={!durationMs} /></div></div>
    </div>
    <div className="sequence-arc"><div className="sequence-section-heading"><h2>Tracks</h2><span>{tracks.length} {tracks.length === 1 ? "track" : "tracks"}</span></div><div className="sequence-track-list">{tracks.map((track, index) => { const groupId = trackGroupId(track); const following = tracks[index + 1] ?? null; return <React.Fragment key={track.id}><div className={`sequence-track ${track.id === current.id ? "is-current" : ""} ${draggedGroupId === groupId ? "is-dragging" : ""}`} draggable onDragStart={() => setDraggedGroupId(groupId)} onDragEnd={() => setDraggedGroupId("")} onDragOver={(event) => event.preventDefault()} onDrop={() => moveGroup(groupId)}><span className="sequence-track-number">{String(index + 1).padStart(2, "0")}</span><span className="sequence-drag-handle" aria-hidden="true"><DotsSixVertical size={14} /></span><button type="button" className="sequence-track-button" onClick={() => onPlayTrack(project, track, index)}><strong>{track.title}</strong><small>{track.versionName} · {track.duration}</small></button></div>{following && <SequenceTransition project={project} fromTrack={track} toTrack={following} transition={sequenceTransition(project, track, following)} onUpdateTransition={onUpdateTransition} onAuditionTransition={onAuditionTransition} />}</React.Fragment>; })}</div></div>
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

  return <div className="sequence-transition"><div className="sequence-transition-line"><span className="sequence-transition-rule" /><span className="eyebrow">Transition</span><span className="sequence-transition-gap">{formatGap(gapMs)} gap</span><button type="button" onClick={() => onAuditionTransition(project, fromTrack, toTrack)}><Waveform size={13} />Audition</button><span className="sequence-transition-rule" /></div><div className="sequence-gap-control"><span>Silence</span><input aria-label={`Gap between ${fromTrack.title} and ${toTrack.title}`} type="range" min="0" max="30000" step="500" value={gapMs} onChange={(event) => setGapMs(Number(event.target.value))} onPointerUp={save} /><span>{formatGap(gapMs)}</span></div><input className="sequence-transition-note" aria-label={`Note between ${fromTrack.title} and ${toTrack.title}`} placeholder="Add a note for this transition" value={note} onChange={(event) => setNote(event.target.value)} onBlur={save} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} /></div>;
}

function formatCapsuleExpiry(expiresAt) {
  if (!expiresAt) return "No expiry";
  return `Expires ${new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(expiresAt))}`;
}

function CapsuleUnlockPrompt({ summary, error, onClose, onSubmit }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(event) {
    event.preventDefault();
    if (!password.trim() || busy) return;
    setBusy(true);
    try { await onSubmit(password); } finally { setBusy(false); }
  }
  return <DialogFrame titleId="capsule-unlock-title" onClose={onClose} className="capsule-unlock-dialog">
    <button className="modal-close" type="button" onClick={onClose} aria-label="Close password prompt"><X size={18} /></button>
    <span className="eyebrow">Local Capsule</span>
    <h2 id="capsule-unlock-title">Unlock this listen</h2>
    <p>{summary.title}</p>
    <form onSubmit={submit}>
      <div className="capsule-password-field"><LockKey size={15} /><input autoFocus type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} placeholder="Capsule password" aria-label="Capsule password" /></div>
      {error && <span className="capsule-unlock-error" role="alert">{error}</span>}
      <span className="modal-note">The password is an opening check for this local Capsule. Audio and notes are not encrypted by it.</span>
      <button className="button button-primary modal-cta" type="submit" disabled={!password.trim() || busy}>{busy ? "Opening…" : "Open Capsule"}</button>
    </form>
  </DialogFrame>;
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
  return (
    <DialogFrame titleId="capsule-create-title" onClose={onClose} className="capsule-create-dialog">
      <header className="capsule-compose-header">
        <img src={project.artwork} alt="" />
        <div>
          <span>{project.title}</span>
          <h2 id="capsule-create-title">New listening capsule</h2>
        </div>
        <button className="modal-close" type="button" onClick={onClose} aria-label="Close capsule builder"><X size={17} /></button>
      </header>
      <form onSubmit={submit}>
        <div className="capsule-compose-body">
          <section className="capsule-selection" aria-label="Track selection">
            <div className="capsule-selection-heading">
              <h3>Tracks</h3><span>{selectedCount} of {groups.length} selected</span>
            </div>
            <div className="capsule-selection-list">
              {groups.map((group) => {
                const selected = Boolean(selectedVersions[group.id]);
                return (
                  <div className="capsule-selection-row" key={group.id}>
                    <label title={group.title}>
                      <input type="checkbox" checked={selected} onChange={() => toggleGroup(group)} />
                      <strong>{group.title}</strong>
                    </label>
                    <select aria-label={`Version for ${group.title}`} value={selectedVersions[group.id] ?? ""} onChange={(event) => setSelectedVersions((current) => ({ ...current, [group.id]: event.target.value }))} disabled={!selected}>
                      {!selected && <option value="">Excluded</option>}
                      {group.versions.map((version) => <option key={version.id} value={version.id}>{version.versionName}{version.isCurrent ? " · current" : ""}</option>)}
                    </select>
                  </div>
                );
              })}
            </div>
          </section>
          <section className="capsule-compose-details" aria-label="Capsule details">
            <h3>Details</h3>
            <div className="modal-field"><label htmlFor="capsule-title">Title</label><input id="capsule-title" value={title} onChange={(event) => setTitle(event.target.value)} required /></div>
            <div className="modal-field"><label htmlFor="capsule-message">Message <span>Optional</span></label><textarea id="capsule-message" rows={2} value={message} onChange={(event) => setMessage(event.target.value)} placeholder="Add a message" /></div>
            <div className="capsule-form-grid">
              <div className="modal-field"><label htmlFor="capsule-expiry">Expires</label><select id="capsule-expiry" value={expiry} onChange={(event) => setExpiry(event.target.value)}><option value="never">Never</option><option value="day">24 hours</option><option value="week">7 days</option><option value="month">30 days</option></select></div>
              <div className="modal-field"><label htmlFor="capsule-password">Password <span>Optional</span></label><input id="capsule-password" type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /></div>
            </div>
            <label className="capsule-notes-toggle"><input type="checkbox" checked={includeNotes} onChange={(event) => setIncludeNotes(event.target.checked)} /> Include project and track notes</label>
          </section>
        </div>
        <footer className="capsule-compose-footer">
          <p><LockKey size={14} aria-hidden="true" /><span>Stored on this device. A password limits access in OPAL; audio and notes stay unencrypted.</span></p>
          <button className="button button-primary" type="submit" disabled={!selectedCount}>Create capsule <ArrowUpRight size={15} /></button>
        </footer>
      </form>
    </DialogFrame>
  );
}

function CapsuleView({ capsule, project, playingTrackId, playbackState, elapsedMs, durationMs, onBack, onPlayTrack, onPlay, onPrevious, onNext, onProgressChange, onCopyReference, onOpenResponse }) {
  const currentIndex = Math.max(0, capsule.tracks.findIndex((track) => track.id === playingTrackId));
  const current = capsule.tracks[currentIndex] ?? capsule.tracks[0];
  const next = capsule.tracks[currentIndex + 1] ?? null;
  const progress = durationMs > 0 ? Math.max(0, Math.min(100, (elapsedMs / durationMs) * 100)) : 0;
  const status = playbackState === "playing" ? "Listening now" : playbackState === "transition" ? "Between songs" : playbackState === "transition-paused" ? "Paused between songs" : "Ready to listen";
  const trackTitle = new Map(capsule.tracks.map((track) => [track.id, track.title]));
  if (!current) return <section className="capsule-room view-stack"><button className="back-action" type="button" onClick={onBack}><ArrowLeft size={16} />Project</button><div className="capsule-empty-state"><span className="eyebrow">Local Capsule</span><h1>No selected versions are available</h1><p>One or more versions in this Capsule may have been removed from the project.</p></div></section>;
  return <section className="capsule-room view-stack">
    <div className="capsule-room-topline">
      <button className="back-action" type="button" onClick={onBack}><ArrowLeft size={16} />Project</button>
      <div className="capsule-room-title"><span className="eyebrow">Listening capsule</span><h1>{capsule.title}</h1></div>
      <div className="capsule-room-actions"><span className="capsule-protection">{capsule.hasPassword ? <><LockKey size={13} />Password protected</> : <><ShieldCheck size={13} />Local only</>}</span><button className="button button-capsule" type="button" onClick={onCopyReference}><Copy size={14} />Copy local reference</button></div>
    </div>
    <div className="capsule-local-disclosure" role="note"><Info size={15} /><span><strong>Stored in this OPAL library.</strong> Passwords are an opening check only; audio and notes are not encrypted, and this reference does not share anything remotely.</span></div>
    <div className="capsule-hero">
      <div className="capsule-artwork-wrap"><img src={capsule.artwork} alt={`${capsule.projectTitle} artwork`} /><span>{formatCapsuleExpiry(capsule.expiresAt)}</span></div>
      <div className="capsule-hero-copy"><span className="eyebrow">{status}</span><h2>{capsule.projectTitle}</h2><p>{capsule.message || capsule.projectDescription || "A focused listen through the project."}</p><div className="capsule-hero-meta"><span>{capsule.tracks.length} selected versions</span><span>{capsule.includeNotes ? "Notes included" : "Listening only"}</span></div><div className="capsule-transport"><button type="button" onClick={onPrevious} aria-label="Previous capsule track"><SkipBack size={17} weight="fill" /></button><button className="capsule-play" type="button" onClick={onPlay} aria-label={playbackState === "playing" ? "Pause capsule" : "Play capsule"}>{playbackState === "playing" ? <Pause size={19} weight="fill" /> : <Play size={19} weight="fill" />}</button><button type="button" onClick={onNext} aria-label="Next capsule track"><SkipForward size={17} weight="fill" /></button></div><div className="capsule-progress"><div><span>{formatTime(elapsedMs)}</span><span>{formatTime(durationMs)}</span></div><input aria-label="Capsule playback position" type="range" min="0" max="100" value={progress} onChange={onProgressChange} disabled={!durationMs} /></div><button className="capsule-response-cta" type="button" onClick={onOpenResponse}><PaperPlaneTilt size={14} />Respond to this moment</button></div>
      <div className="capsule-next-card"><span className="eyebrow">Next in the presentation</span>{next ? <button type="button" onClick={() => onPlayTrack(capsule, next, currentIndex + 1)}><strong>{next.title}</strong><small>{next.versionName} · {next.duration}</small><span>Play next <ArrowUpRight size={13} /></span></button> : <div className="sequence-finale"><strong>End of capsule</strong><small>The listen resolves here.</small></div>}</div>
    </div>
    <div className="capsule-room-grid">
      <div className="capsule-sequence"><div className="capsule-section-heading"><div><span className="eyebrow">Intended order</span><h2>{capsule.title}</h2></div><span>{currentIndex + 1} / {capsule.tracks.length}</span></div><div className="capsule-track-list">{capsule.tracks.map((track, index) => <button type="button" className={`capsule-track ${track.id === current.id ? "is-current" : ""}`} key={track.id} onClick={() => onPlayTrack(capsule, track, index)}><span className="capsule-track-number">{String(index + 1).padStart(2, "0")}</span><span><strong>{track.title}</strong><small>{track.versionName} · {track.duration}</small></span>{track.id === current.id && <span className="capsule-now">Now</span>}<Play size={13} weight="fill" /></button>)}</div></div>
      <aside className="capsule-notes"><span className="eyebrow">{capsule.includeNotes ? "Artist notes" : "A quiet listen"}</span><h2>{capsule.includeNotes ? "Hear the thinking around it." : "The sequence stays in focus."}</h2>{capsule.includeNotes ? <div className="capsule-note-list">{capsule.projectNote?.text && <p>{capsule.projectNote.text}</p>}{capsule.tracks.filter((track) => track.note?.text).map((track) => <div key={track.id}><small>{track.title} · {track.versionName}</small><p>{track.note.text}</p></div>)}{capsule.transitions.filter((transition) => transition.note).map((transition) => <div key={transition.id}><small>Between songs</small><p>{transition.note}</p></div>)}{!capsule.projectNote?.text && !capsule.tracks.some((track) => track.note?.text) && !capsule.transitions.some((transition) => transition.note) && <p className="capsule-muted-copy">No notes were added to this presentation.</p>}</div> : <p>Only the selected versions and their intended order are included in this local presentation.</p>}<div className="capsule-arc-summary"><span>Project arc</span><strong>{capsule.projectTitle}</strong><small>{formatCapsuleExpiry(capsule.expiresAt)}</small></div></aside>
    </div>
    <section className="capsule-responses"><div className="capsule-section-heading"><div><span className="eyebrow">Decision trail</span><h2>Responses</h2></div><span>{capsule.responses.length ? `${capsule.responses.length} returned` : "Nothing returned yet"}</span></div>{capsule.responses.length ? <div className="capsule-response-list">{capsule.responses.map((response) => <article key={response.id}><span className={`capsule-response-state state-${response.state}`}>{momentStateLabel(response.state)}</span><div><strong>{trackTitle.get(response.trackId) ?? "Track"} · {formatTime(response.timeMs)}</strong><p>{response.text}</p></div><small>Returned to OPAL</small></article>)}</div> : <div className="capsule-response-empty"><Broadcast size={17} /><span>Responses stay in this local library and appear on the matching version.</span></div>}</section>
  </section>;
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

function handleActionMenuKeyDown(event, menuRef, onClose) {
  if (event.key === "Escape") {
    event.preventDefault();
    const trigger = menuRef.current?.parentElement?.querySelector('[aria-expanded="true"]');
    onClose();
    window.requestAnimationFrame(() => trigger?.focus());
    return;
  }
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const items = [...(menuRef.current?.querySelectorAll('[role="menuitem"]:not(:disabled)') ?? [])];
  if (!items.length) return;
  event.preventDefault();
  const currentIndex = items.indexOf(document.activeElement);
  const nextIndex = event.key === "Home" ? 0
    : event.key === "End" ? items.length - 1
      : (currentIndex + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
  items[nextIndex]?.focus();
}

function TrackMenu({ group, index, groupCount, onMove, onRename, onAddVersion, onNotes, onRemove, onClose }) {
  const menuRef = useRef(null);
  useEffect(() => {
    function handlePointerDown(event) {
      if (!menuRef.current?.parentElement?.contains(event.target)) onClose();
    }
    document.addEventListener("pointerdown", handlePointerDown);
    menuRef.current?.querySelector("button")?.focus();
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [onClose]);

  return <div ref={menuRef} className="track-menu glass" data-popover role="menu" aria-label={`Actions for ${group.title}`} onKeyDown={(event) => handleActionMenuKeyDown(event, menuRef, onClose)}>
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
    document.addEventListener("pointerdown", handlePointerDown);
    menuRef.current?.querySelector("button")?.focus();
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [onClose]);
  return <div ref={menuRef} className="version-menu glass" data-popover role="menu" aria-label={`Actions for ${version.versionName}`} onKeyDown={(event) => handleActionMenuKeyDown(event, menuRef, onClose)}>
    <span className="eyebrow">Version actions</span>
    <button type="button" role="menuitem" onClick={() => onMove(-1)} disabled={index === 0}><CaretLeft size={14} />Move earlier</button>
    <button type="button" role="menuitem" onClick={() => onMove(1)} disabled={index === versionCount - 1}><CaretRight size={14} />Move later</button>
    <button type="button" role="menuitem" onClick={onRename}><NotePencil size={14} />Rename version</button>
    <button type="button" role="menuitem" onClick={onPromote} disabled={version.isCurrent}><Check size={14} />{version.isCurrent ? "Current version" : "Make current"}</button>
    <button type="button" role="menuitem" onClick={onNotes}><NotePencil size={14} />{version.note?.text ? "Edit notes" : "Open notes"}</button>
    <button type="button" className="track-menu-danger" role="menuitem" onClick={onRemove} disabled={versionCount <= 1}><Trash size={14} />Remove version</button>
  </div>;
}

function MomentList({ project, track, selectedMomentId, onSelectMoment, onJumpMoment, onUpdateMoment, onDeleteMoment, onJumpUnresolved }) {
  const moments = [...(track.moments ?? [])].sort((left, right) => left.timeMs - right.timeMs);
  const group = groupTracks(project).find((item) => item.versions.some((version) => version.id === track.id));
  const versions = group?.versions ?? [track];
  const [compareMomentId, setCompareMomentId] = useState("");
  const selectedMoment = moments.find((moment) => moment.id === compareMomentId) ?? null;

  useEffect(() => {
    if (compareMomentId && !moments.some((moment) => moment.id === compareMomentId)) setCompareMomentId("");
  }, [compareMomentId, moments]);

  const unresolvedCount = moments.filter((moment) => !moment.isResolved).length;
  return <section className="moment-section" aria-label="Annotation halo"><div className="moment-section-heading"><div><span className="eyebrow">Annotation halo</span><h3>Moments</h3></div><div className="moment-nav"><button type="button" onClick={() => onJumpUnresolved(-1)} disabled={!unresolvedCount} aria-label="Previous unresolved moment" title="Previous unresolved moment"><CaretLeft size={13} /></button><span>{unresolvedCount ? `${unresolvedCount} open` : "All clear"}</span><button type="button" onClick={() => onJumpUnresolved(1)} disabled={!unresolvedCount} aria-label="Next unresolved moment" title="Next unresolved moment"><CaretRight size={13} /></button></div></div>{moments.length ? <div className="moment-list">{moments.map((moment) => <MomentCard key={moment.id} project={project} track={track} moment={moment} versions={versions} selected={moment.id === selectedMomentId} onSelect={onSelectMoment} onJump={onJumpMoment} onUpdate={onUpdateMoment} onDelete={onDeleteMoment} onCompare={() => setCompareMomentId(compareMomentId === moment.id ? "" : moment.id)} />)}</div> : <div className="moment-empty"><Waveform size={16} /><span>Click the waveform to leave a timestamped decision.</span></div>}{selectedMoment && <MomentCompare project={project} track={track} moment={selectedMoment} versions={versions} onJumpMoment={onJumpMoment} onClose={() => setCompareMomentId("")} />}</section>;
}

function MomentCard({ project, track, moment, versions, selected, onSelect, onJump, onUpdate, onDelete, onCompare }) {
  const [draftText, setDraftText] = useState(moment.text);
  useEffect(() => setDraftText(moment.text), [moment.id, moment.text]);
  const saveText = () => {
    if (draftText !== moment.text) onUpdate(project, moment, { text: draftText });
  };
  return <article className={`moment-card state-${moment.state} ${moment.isResolved ? "is-resolved" : ""} ${selected ? "is-selected" : ""}`} onClick={() => onSelect?.(moment)}><div className="moment-card-top"><button type="button" className="moment-time" onClick={() => onJump(project, track, moment)}><span className="moment-dot" aria-hidden="true" />{formatTime(moment.timeMs)}</button><span className={`moment-decision state-${moment.state}`}>{momentStateLabel(moment.state)}</span><button type="button" className="moment-resolve" onClick={() => onUpdate(project, moment, { isResolved: !moment.isResolved })}>{moment.isResolved ? "Reopen" : "Resolve"}</button><button type="button" className="moment-remove" onClick={(event) => { event.stopPropagation(); onDelete?.(project, moment); }} aria-label={`Remove moment at ${formatTime(moment.timeMs)}`} title="Remove moment"><Trash size={13} /></button></div><div className="moment-state-picker" aria-label={`Decision for ${formatTime(moment.timeMs)}`}>{MOMENT_STATES.map((state) => <button type="button" key={state} className={moment.state === state ? "is-active" : ""} onClick={() => onUpdate(project, moment, { state })} aria-pressed={moment.state === state}>{momentStateLabel(state)}</button>)}</div><input className="moment-text" value={draftText} onChange={(event) => setDraftText(event.target.value)} onBlur={saveText} onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} placeholder="What should change here?" aria-label={`Note for moment at ${formatTime(moment.timeMs)}`} /><div className="moment-card-footer"><span>{moment.isResolved ? "Kept in history" : "Needs a decision"}</span>{versions.length > 1 && <button type="button" className="moment-compare-button" onClick={onCompare}>Compare versions</button>}</div></article>;
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

function WaveformProgress({ track, progress, durationMs, showWaveform, moments = [], selectedMomentId, onChange, onSelectMoment, onCreateMoment }) {
  const [bars, setBars] = useState([]);
  const [analysisState, setAnalysisState] = useState("loading");

  useEffect(() => {
    if (!showWaveform) return;
    let cancelled = false;
    const cached = readCachedWaveform(track);
    if (cached?.length) {
      setBars(cached);
      setAnalysisState("ready");
      return () => { cancelled = true; };
    }
    setBars([]);
    if (!isTauri() || !track.managedFileRef) {
      setAnalysisState("unavailable");
      return () => { cancelled = true; };
    }
    setAnalysisState("loading");
    invoke("getAudioWaveform", { managedFileRef: track.managedFileRef }).then((nextBars) => {
      if (cancelled) return;
      const normalizedBars = Array.from(nextBars ?? [], (bar) => Number(bar)).filter(Number.isFinite);
      if (normalizedBars.length) {
        writeCachedWaveform(track, normalizedBars);
        setBars(normalizedBars);
        setAnalysisState("ready");
      } else {
        setAnalysisState("unavailable");
      }
    }).catch(() => {
      if (!cancelled) setAnalysisState("unavailable");
    });
    return () => { cancelled = true; };
  }, [showWaveform, track.id, track.managedFileRef, track.title, track.durationMs, track.format]);

  const safeProgress = Math.max(0, Math.min(100, Number(progress) || 0));
  const renderBars = (layer) => bars.map((height, index) => <span key={`${layer}-${index}`} style={{ height: `${height}%` }} />);

  const waveformReady = showWaveform && analysisState === "ready";

  return <div id="player-seek" className={`waveform-progress${waveformReady ? " is-waveform" : ""}`} style={{ "--waveform-progress": `${safeProgress}%` }} role="group" aria-label="Playback waveform" onContextMenu={(event) => {
    if (event.target?.closest?.(".moment-marker")) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!durationMs || !onCreateMoment || bounds.width <= 0) return;
    const position = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    onCreateMoment(position * durationMs);
  }}>
    {waveformReady && <>
      <div className="waveform-layer waveform-layer-muted" aria-hidden="true">{renderBars("muted")}</div>
      <div className="waveform-layer waveform-layer-active" aria-hidden="true">{renderBars("active")}</div>
    </>}
    {showWaveform && !waveformReady && <span className={`waveform-analysis is-${analysisState}`} role="status">{analysisState === "loading" ? "Analyzing waveform" : "Waveform unavailable"}</span>}
    <span className="waveform-cursor" aria-hidden="true" />
    {moments.filter((moment) => durationMs > 0 && moment.timeMs >= 0 && moment.timeMs <= durationMs).map((moment) => <button type="button" key={moment.id} className={`moment-marker state-${moment.state} ${moment.isResolved ? "is-resolved" : ""} ${selectedMomentId === moment.id ? "is-selected" : ""}`} style={{ left: `${(moment.timeMs / durationMs) * 100}%` }} onClick={(event) => { event.stopPropagation(); onSelectMoment?.(moment); }} aria-label={`${momentStateLabel(moment.state)} moment at ${formatTime(moment.timeMs)}`} title={`${momentStateLabel(moment.state)} · ${formatTime(moment.timeMs)}`} />)}
    <input className="waveform-input" aria-label="Playback position" title="Click or drag to seek · Right-click to add a moment · Press M at the playhead" type="range" min="0" max="100" step="any" aria-valuetext={`${formatTime(durationMs * safeProgress / 100)} of ${formatTime(durationMs)}`} value={safeProgress} onChange={onChange} disabled={!durationMs} />
  </div>;
}

function Player({ project, track, selectedMomentId, status, playbackError, isPlaying, progress, elapsedMs, durationMs, volume, muted, volumeOpen, queueOpen, menuOpen, shuffleEnabled, repeatMode, onTogglePlay, onPrevious, onNext, onProgressChange, onCreateMoment, onSelectMoment, onVolumeChange, onToggleMute, onToggleVolume, onToggleQueue, onToggleMenu, onToggleShuffle, onToggleRepeat, onOpenProject, onShowTrack, onOpenNotes, onRevealFile, onShowInfo }) {
  const [showWaveform, setShowWaveform] = useState(false);
  const statusText = status === "loading" ? "Loading" : status === "error" ? "Unavailable" : status === "transition" ? "Breathing room" : status === "transition-paused" ? "Paused between songs" : `${track.versionName ?? "Original"} · ${project.title}`;
  const repeatLabel = repeatMode === "track" ? "Repeat track" : repeatMode === "project" ? "Repeat project" : "Repeat off";
  return <section className="player-shell glass" aria-label="Audio player">
    <div className="player-controls">
      <button type="button" onClick={onPrevious} aria-label="Previous track" title="Previous track"><Rewind size={20} weight="fill" /></button>
      <button type="button" className="play-button" onClick={onTogglePlay} aria-label={isPlaying ? "Pause" : "Play"} aria-keyshortcuts="Space" title={`${isPlaying ? "Pause" : "Play"} (Space)`}>{isPlaying ? <Pause size={18} weight="fill" /> : <Play size={18} weight="fill" />}</button>
      <button type="button" onClick={onNext} aria-label="Next track" title="Next track"><FastForward size={20} weight="fill" /></button>
    </div>
    <div className="player-center" key={`${project.id}:${track.id}`}>
      <div className="player-cover-wash" data-playing={isPlaying} aria-hidden="true">
        <span className="player-cover-tide"><img src={project.artwork} alt="" /></span>
        <span className="player-cover-tide player-cover-current"><img src={project.artwork} alt="" /></span>
      </div>
      <div className="player-track">
        <img src={project.artwork} alt="" />
        <span><strong>{track.title}</strong><small>{playbackError || statusText}</small></span>
        <button
          className="player-waveform-action"
          type="button"
          onClick={() => setShowWaveform((visible) => !visible)}
          aria-label="Waveform view"
          aria-pressed={showWaveform}
          aria-controls="player-seek"
          title={showWaveform ? "Show progress bar" : "Show waveform"}
        ><Waveform size={18} weight="bold" /></button>
        <span className="player-menu-wrap"><button className="player-more" type="button" onClick={onToggleMenu} aria-label="Open player menu" aria-expanded={menuOpen} title="Track options"><DotsThree size={18} /></button>{menuOpen && <PlayerMenu track={track} elapsedMs={elapsedMs} onCreateMoment={onCreateMoment} onOpenProject={onOpenProject} onShowTrack={onShowTrack} onOpenNotes={onOpenNotes} onRevealFile={onRevealFile} onShowInfo={onShowInfo} onClose={onToggleMenu} />}</span>
      </div>
      <div className="player-progress">
        <span className="player-time">{formatTime(elapsedMs)}</span>
        <WaveformProgress track={track} showWaveform={showWaveform} moments={track.moments} selectedMomentId={selectedMomentId} progress={progress} durationMs={durationMs} onChange={onProgressChange} onSelectMoment={onSelectMoment} onCreateMoment={onCreateMoment} />
        <span className="player-time">{formatTime(durationMs)}</span>
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
  return <div ref={popoverRef} className="volume-popover" role="dialog" aria-label="Volume control"><div className="volume-slider" style={{ "--volume-level": `${volumeValue}%` }}><span className="volume-slider-rail" aria-hidden="true" /><span className="volume-slider-fill" aria-hidden="true" /><span className="volume-slider-thumb" aria-hidden="true" /><input className="volume-slider-input" aria-label="Volume" type="range" min="0" max="100" step="any" value={volumeValue} onChange={onChange} /></div><button type="button" className="volume-mute" onClick={onToggleMute} aria-label={muted ? "Unmute" : "Mute"} title={muted ? "Unmute" : "Mute"}>{muted ? <SpeakerX size={20} /> : <SpeakerHigh size={20} />}</button></div>;
}

function DialogFrame({ titleId, onClose, children, className = "", backdrop, dismissOnBackdrop = true }) {
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

  return (
    <div
      className="modal-backdrop"
      role="presentation"
      onMouseDown={(event) => { if (dismissOnBackdrop && event.target === event.currentTarget) onClose(); }}
    >
      {backdrop}
      <section ref={dialogRef} className={`import-prompt glass modal-form ${className}`} role="dialog" aria-modal="true" aria-labelledby={titleId} onMouseDown={(event) => event.stopPropagation()}>
        {children}
      </section>
    </div>
  );
}

function ProfilePopover({ nativeAvailable, storageInfo, storageError, importProgress, updateStatus, updateAvailable, onCheckUpdates, onOpenUpdates, onPreviewUpdateBanner, onRevealFolder, onExportBackup, onRestoreBackup, onRetryStorage, onDiagnostics, onReplayWelcome, onClose }) {
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
  return <div ref={popoverRef} className="profile-popover glass" data-popover role="dialog" aria-label="OPAL settings"><div className="profile-heading"><div><span className="eyebrow">OPAL</span><h2>Settings</h2></div><button type="button" className="popover-close" onClick={onClose} aria-label="Close settings"><X size={15} /></button></div><div className="storage-card"><div className="storage-card-heading"><Database size={16} /><span>Library storage</span><strong>{storageInfo ? formatBytes(storageInfo.totalBytes) : "—"}</strong></div>{storageError ? <div className="popover-error" role="alert"><span>Couldn’t load storage details.</span><button type="button" onClick={onRetryStorage}>Retry</button></div> : <><p>{storageInfo ? `${storageInfo.projectCount} projects · ${storageInfo.trackCount} tracks` : nativeAvailable ? "Loading storage details…" : "Storage details unavailable in preview."}</p><code>{storageInfo?.folderPath ?? "Open the native app to view the library folder."}</code></>}</div><div className="popover-actions"><button type="button" className="settings-update-action" onClick={updateAvailable ? onOpenUpdates : onCheckUpdates} disabled={!nativeAvailable || updateStatus === "checking"}><CloudCheck size={15} />{updateStatus === "checking" ? "Checking for updates…" : updateAvailable ? "Update available" : "Check for updates"}<span>OPAL {APP_VERSION}</span></button>{(import.meta.env.DEV || import.meta.env.VITE_OPAL_DEVELOPMENT === "1") && onPreviewUpdateBanner && <button type="button" onClick={onPreviewUpdateBanner}><CloudCheck size={15} />Preview update banner</button>}<button type="button" onClick={onRevealFolder} disabled={!nativeAvailable} title={nativeAvailable ? "Reveal the OPAL library folder" : nativeHint}><FolderOpen size={15} />Reveal library folder</button><button type="button" onClick={onExportBackup} disabled={!nativeAvailable} title={nativeAvailable ? "Export a complete OPAL backup" : nativeHint}><Export size={15} />Export library backup</button><button type="button" onClick={onRestoreBackup} disabled={!nativeAvailable} title={nativeAvailable ? "Restore an OPAL backup" : nativeHint}><ArrowSquareOut size={15} />Restore backup</button><button type="button" onClick={onReplayWelcome}><Play size={15} />Replay welcome</button></div>{importProgress?.status === "processing" && <div className="profile-import-status"><CircleNotch size={14} className="spin" />Importing {importProgress.current ?? 0}/{importProgress.total ?? 0}</div>}<div className="popover-footer"><span>OPAL {APP_VERSION}</span><button type="button" onClick={onDiagnostics} disabled={!nativeAvailable} title={nativeAvailable ? "Open diagnostics" : nativeHint}><Info size={14} />Diagnostics</button></div></div>;
}

function RecoveryView({ onRevealFolder, onRestore, onRetry }) {
  return <section className="recovery-screen view-stack"><div className="recovery-card glass"><WarningCircle size={30} /><span className="eyebrow">Local library</span><h1>Recovery needed</h1><p>OPAL could not safely open the library database. Your managed files were left in place.</p><div className="recovery-actions"><button className="button button-primary" type="button" onClick={onRestore}>Restore backup</button><button className="button button-ghost" type="button" onClick={onRetry}>Try again</button><button className="text-action" type="button" onClick={onRevealFolder}>Reveal library folder <FolderOpen size={14} /></button></div></div></section>;
}

function CompatibilityView({ onRevealFolder }) {
  return <section className="recovery-screen view-stack"><div className="recovery-card glass"><WarningCircle size={30} /><span className="eyebrow">Local library</span><h1>Newer OPAL version required</h1><p>This library was opened by a newer OPAL build. Install a newer build to continue. OPAL has left the library and its managed files unchanged.</p><div className="recovery-actions"><button className="button button-ghost" type="button" onClick={onRevealFolder}>Reveal library folder <FolderOpen size={14} /></button></div></div></section>;
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
  return <div ref={menuRef} className="player-menu glass" data-popover role="menu" aria-label={`Actions for ${track.title}`}><span className="eyebrow">Current track</span><button type="button" role="menuitem" aria-keyshortcuts="M" title="Press M to add a moment at the playhead" onClick={() => run(() => onCreateMoment?.(elapsedMs))} disabled={!onCreateMoment || !track.durationMs}><NotePencil size={15} />Add moment here <kbd>M</kbd></button><button type="button" role="menuitem" onClick={() => run(onOpenProject)}><FolderOpen size={15} />Open project</button><button type="button" role="menuitem" onClick={() => run(onShowTrack)}><ListBullets size={15} />Show in project</button><button type="button" role="menuitem" onClick={() => run(onOpenNotes)}><NotePencil size={15} />Open track notes</button><button type="button" role="menuitem" onClick={() => run(onRevealFile)} disabled={!track.managedFilePath} title={track.managedFilePath ? "Reveal the managed audio file" : "The managed audio file is missing"}><ArrowSquareOut size={15} />Reveal managed file</button><button type="button" role="menuitem" onClick={() => run(onShowInfo)}><Info size={15} />Track information</button></div>;
}

function TrackInfoDialog({ project, track, onClose }) {
  return <DialogFrame titleId="track-info-title" onClose={onClose} className="info-dialog"><button className="modal-close" type="button" onClick={onClose} aria-label="Close track information"><X size={18} /></button><span className="eyebrow">Track version</span><h2 id="track-info-title">{track.title}</h2><p className="dialog-subtitle">{track.versionName ?? "Original"} · {project.title}</p><dl className="info-list"><div><dt>Source title</dt><dd>{track.sourceTitle || track.title}</dd></div><div><dt>Format</dt><dd>{track.format || "Unknown"}</dd></div><div><dt>Duration</dt><dd>{track.duration}</dd></div><div><dt>Current</dt><dd>{track.isCurrent ? "Yes" : "No"}</dd></div><div><dt>Managed audio</dt><dd>{track.managedFilePath ? "Available" : "Missing"}</dd></div><div><dt>Notes</dt><dd>{track.note?.text ? "Has notes" : "Empty"}</dd></div></dl><button className="button button-primary modal-cta" type="button" onClick={onClose}>Done</button></DialogFrame>;
}

function DiagnosticsDialog({ diagnostics, notice, onCopy, onExport, onClose }) {
  const report = serializeDiagnosticsReport(diagnostics);
  return <DialogFrame titleId="diagnostics-title" onClose={onClose} className="info-dialog diagnostics-dialog">
    <button className="modal-close" type="button" onClick={onClose} aria-label="Close diagnostics"><X size={18} /></button>
    <span className="eyebrow">OPAL {diagnostics?.appVersion ?? APP_VERSION}</span>
    <h2 id="diagnostics-title">Diagnostics</h2>
    <p className="dialog-subtitle">Review this local report before sharing it. It excludes music, note text, credentials, and full file paths.</p>
    <dl className="info-list diagnostics-facts">
      <div><dt>Build</dt><dd>{diagnostics?.buildCommit ?? "Unavailable"}</dd></div>
      <div><dt>Target</dt><dd>{diagnostics ? `${diagnostics.platform} · ${diagnostics.architecture}` : "Unavailable"}</dd></div>
      <div><dt>Database schema</dt><dd>{diagnostics?.databaseVersion ?? "Unavailable"} / {diagnostics?.schemaVersion ?? "Unavailable"}</dd></div>
      <div><dt>Integrity</dt><dd>{diagnostics?.integrity ?? "Unavailable"}</dd></div>
      <div><dt>Recent errors</dt><dd>{diagnostics?.recentErrors?.length ?? 0}</dd></div>
    </dl>
    <pre className="diagnostics-report" aria-label="Diagnostics report preview">{report}</pre>
    <div className="diagnostics-actions">
      <button className="button button-ghost" type="button" onClick={onCopy}><Copy size={15} />Copy report</button>
      <button className="button button-primary" type="button" onClick={onExport}><Export size={15} />Export JSON</button>
    </div>
    <p className="diagnostics-notice" role="status" aria-live="polite">{notice || "Sharing is always your choice. Inspect the report before sending it."}</p>
    <button className="button button-ghost modal-cta" type="button" onClick={onClose}>Done</button>
  </DialogFrame>;
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
  const importedCount = results.filter((result) => result.status === "imported").length;
  const compactAddMore = importedCount > 0 && progress?.status !== "processing";

  return <DialogFrame titleId="import-title" onClose={onClose} dismissOnBackdrop={false}>
    <button className="modal-close" type="button" onClick={onClose} aria-label="Close import prompt"><X size={18} /></button>
    <span className="eyebrow">{groupTitle ? "Add a version" : "New tracks"}</span>
    <h2 id="import-title">{groupTitle ? "Add bounce to " + groupTitle : "Import audio"}</h2>
    <p>{groupTitle ? "This bounce will stay with the track and keep its own notes." : "Files are copied into OPAL storage. Originals stay untouched."}</p>
    {compactAddMore ? <div className="import-complete-action">
      <div className="import-complete-copy"><Check size={17} weight="bold" /><span><strong>{importedCount === 1 ? "Track added" : importedCount + " tracks added"}</strong><small>Ready in {project.title}</small></span></div>
      <button className="import-add-more" type="button" onClick={onChooseFiles}><Plus size={15} />Add more</button>
    </div> : <button className="drop-zone" type="button" onClick={onChooseFiles}><FileAudio size={26} weight="thin" /><strong>Choose audio</strong><span>WAV · MP3 · FLAC · AIFF · M4A</span></button>}
    {progress && <div className={"import-summary is-" + progress.status} aria-live="polite">
      <div className="import-summary-top"><span>{progress.status === "processing" ? "Importing" : progress.status === "error" ? "Import error" : progress.status === "duplicates" ? "Duplicates" : "Complete"}</span><strong>{current}/{total}</strong></div>
      <div className="import-progress-bar"><span style={{ width: String(progressPercent) + "%" }} /></div>
      {progress.message && <small>{progress.message}</small>}
    </div>}
    {results.length > 0 && <div className="import-results">{results.map((result) => <div className={"import-result is-" + result.status} key={result.path + "-" + result.status}><span><strong>{result.fileName}</strong><small>{result.message}</small></span><em>{result.status}</em></div>)}</div>}
    {progress?.status === "error" && <div className="import-actions"><button className="button button-primary" type="button" onClick={onRetryImport}>Retry import</button></div>}
    {duplicatePaths.length > 0 && <div className="import-actions"><button className="button button-primary" type="button" onClick={onImportDuplicates}>Import duplicates</button><button className="button button-ghost" type="button" onClick={onSkipDuplicates}>Skip duplicates</button></div>}
  </DialogFrame>;
}

export { App };
