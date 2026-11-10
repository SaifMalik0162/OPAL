import { AppState, type AppStateStatus } from 'react-native';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { createAudioPlayer, setAudioModeAsync, type AudioPlayer, type AudioStatus } from 'expo-audio';
import { useSQLiteContext } from 'expo-sqlite';
import { audioUri, getProject, readPlaybackBookmark, savePlaybackBookmark } from '../data/database';
import type { Track } from '../data/models';

export type PlaybackSnapshot = {
  track: Track | null;
  queue: Track[];
  queueIndex: number;
  playing: boolean;
  loading: boolean;
  positionMs: number;
  durationMs: number;
  error: string | null;
};

type PlaybackActions = {
  playQueue: (tracks: Track[], index: number) => Promise<void>;
  playMoment: (tracks: Track[], trackId: string, positionMs: number) => Promise<void>;
  toggle: () => void;
  skip: (direction: -1 | 1) => void;
  seek: (positionMs: number) => Promise<void>;
  capturePosition: () => number;
};

const PlaybackStateContext = createContext<PlaybackSnapshot | null>(null);
const PlaybackActionsContext = createContext<PlaybackActions | null>(null);
const disposedAudioPlayers = new WeakSet<AudioPlayer>();

const EMPTY_SNAPSHOT: PlaybackSnapshot = {
  track: null,
  queue: [],
  queueIndex: -1,
  playing: false,
  loading: false,
  positionMs: 0,
  durationMs: 0,
  error: null,
};

export function PlaybackProvider({ children }: { children: ReactNode }) {
  const db = useSQLiteContext();
  const [snapshot, setSnapshot] = useState(EMPTY_SNAPSHOT);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const playerRef = useRef<AudioPlayer | null>(null);
  const pendingPlayerRef = useRef<AudioPlayer | null>(null);
  const loadAbortRef = useRef<AbortController | null>(null);
  const statusSubscriptionRef = useRef<{ remove: () => void } | null>(null);
  const loadGenerationRef = useRef(0);
  const lastCheckpointRef = useRef(0);
  const handledFinishRef = useRef('');
  const loadTrackRef = useRef<(tracks: Track[], index: number, positionMs: number, autoplay: boolean) => Promise<void>>(async () => {});

  const loadTrack = useCallback(async (tracks: Track[], index: number, positionMs: number, autoplay: boolean) => {
    const track = tracks[index];
    if (!track) return;

    const generation = ++loadGenerationRef.current;
    loadAbortRef.current?.abort();
    disposeAudioPlayer(pendingPlayerRef.current);
    pendingPlayerRef.current = null;
    const oldPlayer = playerRef.current;
    oldPlayer?.pause();
    disposeAudioPlayer(oldPlayer);
    removeSubscription(statusSubscriptionRef.current);
    statusSubscriptionRef.current = null;
    playerRef.current = null;
    setSnapshot({
      track,
      queue: tracks,
      queueIndex: index,
      playing: false,
      loading: true,
      positionMs: Math.max(0, positionMs),
      durationMs: track.durationMs,
      error: null,
    });

    const nextPlayer = createAudioPlayer({ uri: audioUri(track.fileName), name: track.title }, {
      updateInterval: 500,
      keepAudioSessionActive: true,
    });
    pendingPlayerRef.current = nextPlayer;
    const loadAbortController = new AbortController();
    loadAbortRef.current = loadAbortController;
    let durationPersisted = track.durationMs > 0;
    try {
      const initialStatus = await waitForLoaded(nextPlayer, loadAbortController.signal);
      if (generation !== loadGenerationRef.current) {
        disposeAudioPlayer(nextPlayer);
        if (pendingPlayerRef.current === nextPlayer) pendingPlayerRef.current = null;
        return;
      }

      const durationMs = Math.max(track.durationMs, Math.round(initialStatus.duration * 1000));
      const safePositionMs = durationMs > 0 ? Math.min(Math.max(0, positionMs), durationMs) : Math.max(0, positionMs);
      await nextPlayer.seekTo(safePositionMs / 1000);
      if (generation !== loadGenerationRef.current) {
        disposeAudioPlayer(nextPlayer);
        if (pendingPlayerRef.current === nextPlayer) pendingPlayerRef.current = null;
        return;
      }

      removeSubscription(statusSubscriptionRef.current);
      pendingPlayerRef.current = null;
      if (loadAbortRef.current === loadAbortController) loadAbortRef.current = null;
      playerRef.current = nextPlayer;
      handledFinishRef.current = '';
      nextPlayer.setActiveForLockScreen(true, {
        title: track.title,
        artist: 'OPAL',
        albumTitle: track.projectTitle,
      }, { showSeekForward: true, showSeekBackward: true, seekForwardIntervalSeconds: 15, seekBackwardIntervalSeconds: 15 });

      statusSubscriptionRef.current = nextPlayer.addListener('playbackStatusUpdate', (status) => {
        if (playerRef.current !== nextPlayer || generation !== loadGenerationRef.current) return;
        const currentPositionMs = Math.max(0, Math.round(status.currentTime * 1000));
        const currentDurationMs = Math.max(track.durationMs, Math.round(status.duration * 1000));
        setSnapshot((current) => ({
          ...current,
          track: currentDurationMs > 0 && current.track?.id === track.id
            ? { ...track, durationMs: currentDurationMs }
            : track,
          playing: status.playing,
          loading: !status.isLoaded,
          positionMs: currentPositionMs,
          durationMs: currentDurationMs,
          error: status.error ?? null,
        }));

        const now = Date.now();
        if (currentDurationMs > 0 && !durationPersisted) {
          durationPersisted = true;
          void db.runAsync('UPDATE tracks SET duration_ms = ? WHERE id = ? AND duration_ms = 0', currentDurationMs, track.id);
        }
        if (status.isLoaded && now - lastCheckpointRef.current >= 5000) {
          lastCheckpointRef.current = now;
          void savePlaybackBookmark(db, { trackId: track.id, projectId: track.projectId, positionMs: currentPositionMs });
        }

        if (status.didJustFinish && handledFinishRef.current !== track.id) {
          handledFinishRef.current = track.id;
          if (index < tracks.length - 1) {
            void loadTrackRef.current(tracks, index + 1, 0, true);
          } else {
            nextPlayer.pause();
            void nextPlayer.seekTo(0);
            setSnapshot((current) => ({ ...current, playing: false, positionMs: 0 }));
            void savePlaybackBookmark(db, { trackId: track.id, projectId: track.projectId, positionMs: 0 });
          }
        }
      });

      setSnapshot((current) => ({
        ...current,
        track: { ...track, durationMs },
        playing: false,
        loading: false,
        positionMs: safePositionMs,
        durationMs,
      }));
      lastCheckpointRef.current = Date.now();
      await savePlaybackBookmark(db, { trackId: track.id, projectId: track.projectId, positionMs: safePositionMs });
      if (autoplay && generation === loadGenerationRef.current) {
        nextPlayer.play();
        setSnapshot((current) => ({ ...current, playing: true }));
      }
    } catch (error) {
      if (generation === loadGenerationRef.current) {
        removeSubscription(statusSubscriptionRef.current);
        statusSubscriptionRef.current = null;
        if (pendingPlayerRef.current === nextPlayer) pendingPlayerRef.current = null;
        if (loadAbortRef.current === loadAbortController) loadAbortRef.current = null;
        if (playerRef.current !== nextPlayer) disposeAudioPlayer(nextPlayer);
        setSnapshot((current) => ({
          ...current,
          loading: false,
          playing: false,
          error: error instanceof Error ? error.message : 'This audio file could not be opened.',
        }));
      } else {
        if (pendingPlayerRef.current === nextPlayer) pendingPlayerRef.current = null;
        if (loadAbortRef.current === loadAbortController) loadAbortRef.current = null;
        disposeAudioPlayer(nextPlayer);
      }
    }
  }, [db]);
  loadTrackRef.current = loadTrack;

  const playQueue = useCallback(async (tracks: Track[], index: number) => {
    if (tracks[index]) await loadTrack(tracks, index, 0, true);
  }, [loadTrack]);

  const playMoment = useCallback(async (tracks: Track[], trackId: string, positionMs: number) => {
    const index = tracks.findIndex((track) => track.id === trackId);
    if (index >= 0) await loadTrack(tracks, index, positionMs, true);
  }, [loadTrack]);

  const toggle = useCallback(() => {
    const player = playerRef.current;
    const current = snapshotRef.current;
    if (player) {
      if (player.playing) {
        player.pause();
        setSnapshot((previous) => ({ ...previous, playing: false, positionMs: Math.round(player.currentTime * 1000) }));
        if (current.track) {
          void savePlaybackBookmark(db, {
            trackId: current.track.id,
            projectId: current.track.projectId,
            positionMs: Math.round(player.currentTime * 1000),
          });
        }
      } else {
        player.play();
        setSnapshot((current) => ({ ...current, playing: true, error: null }));
      }
      return;
    }
    if (current.track && current.queueIndex >= 0) {
      void loadTrack(current.queue, current.queueIndex, current.positionMs, true);
    }
  }, [db, loadTrack]);

  const seek = useCallback(async (positionMs: number) => {
    const player = playerRef.current;
    const current = snapshotRef.current;
    const duration = player?.duration ? Math.round(player.duration * 1000) : current.durationMs;
    const target = Math.min(Math.max(0, Math.round(positionMs)), duration > 0 ? duration : Math.max(0, Math.round(positionMs)));
    if (player) await player.seekTo(target / 1000);
    setSnapshot((current) => ({ ...current, positionMs: target }));
    if (current.track) {
      await savePlaybackBookmark(db, { trackId: current.track.id, projectId: current.track.projectId, positionMs: target });
    }
  }, [db]);

  const skip = useCallback((direction: -1 | 1) => {
    const current = snapshotRef.current;
    if (!current.track) return;
    if (direction < 0 && current.positionMs > 3000) {
      void seek(0);
      return;
    }
    const nextIndex = current.queueIndex + direction;
    if (nextIndex >= 0 && nextIndex < current.queue.length) {
      void loadTrack(current.queue, nextIndex, 0, true);
    }
  }, [loadTrack, seek]);

  const capturePosition = useCallback(() => {
    const player = playerRef.current;
    return player ? Math.max(0, Math.round(player.currentTime * 1000)) : snapshotRef.current.positionMs;
  }, []);

  const actions = useMemo<PlaybackActions>(() => ({ playQueue, playMoment, toggle, skip, seek, capturePosition }), [playQueue, playMoment, toggle, skip, seek, capturePosition]);

  useEffect(() => {
    let cancelled = false;
    void setAudioModeAsync({
      playsInSilentMode: true,
      shouldPlayInBackground: true,
      interruptionMode: 'doNotMix',
    }).then(async () => {
      const bookmark = await readPlaybackBookmark(db);
      if (!bookmark || cancelled) return;
      const project = await getProject(db, bookmark.projectId);
      if (!project || cancelled) return;
      const index = project.tracks.findIndex((track) => track.id === bookmark.trackId);
      if (index >= 0) await loadTrackRef.current(project.tracks, index, bookmark.positionMs, false);
    }).catch((error: unknown) => {
      if (!cancelled) {
        setSnapshot((current) => ({
          ...current,
          error: error instanceof Error ? error.message : 'Playback could not be restored.',
        }));
      }
    });
    return () => {
      cancelled = true;
      loadGenerationRef.current += 1;
      loadAbortRef.current?.abort();
      loadAbortRef.current = null;
      removeSubscription(statusSubscriptionRef.current);
      disposeAudioPlayer(pendingPlayerRef.current);
      disposeAudioPlayer(playerRef.current);
      pendingPlayerRef.current = null;
      playerRef.current = null;
    };
  }, [db]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState: AppStateStatus) => {
      if (nextState === 'active' || !snapshot.track) return;
      const positionMs = capturePosition();
      void savePlaybackBookmark(db, { trackId: snapshot.track.id, projectId: snapshot.track.projectId, positionMs });
    });
    return () => subscription.remove();
  }, [capturePosition, db, snapshot.track]);

  return (
    <PlaybackActionsContext.Provider value={actions}>
      <PlaybackStateContext.Provider value={snapshot}>{children}</PlaybackStateContext.Provider>
    </PlaybackActionsContext.Provider>
  );
}

export function usePlaybackState() {
  const value = useContext(PlaybackStateContext);
  if (!value) throw new Error('usePlaybackState must be used inside PlaybackProvider.');
  return value;
}

export function usePlaybackActions() {
  const value = useContext(PlaybackActionsContext);
  if (!value) throw new Error('usePlaybackActions must be used inside PlaybackProvider.');
  return value;
}

function waitForLoaded(player: AudioPlayer, signal: AbortSignal): Promise<AudioStatus> {
  return new Promise((resolve, reject) => {
    let complete = false;
    let subscription: { remove: () => void } | null = null;
    const timeout = setTimeout(() => finish(new Error('This audio file took too long to open.')), 15000);
    const finish = (error: Error | null, status?: AudioStatus) => {
      if (complete) return;
      complete = true;
      clearTimeout(timeout);
      subscription?.remove();
      signal.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(status ?? player.currentStatus);
    };
    const onAbort = () => finish(new Error('Playback loading was cancelled.'));

    subscription = player.addListener('playbackStatusUpdate', (status) => {
      if (status.error) finish(new Error(status.error));
      else if (status.isLoaded) finish(null, status);
    });
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
    if (player.isLoaded) finish(null, player.currentStatus);
  });
}

function removeSubscription(subscription: { remove: () => void } | null) {
  subscription?.remove();
}

function disposeAudioPlayer(player: AudioPlayer | null) {
  if (!player || disposedAudioPlayers.has(player)) return;
  disposedAudioPlayers.add(player);
  player.clearLockScreenControls();
  player.remove();
}
