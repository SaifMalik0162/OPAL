export function resolveCarouselListenTarget({ project, currentTracks = [], activePlayback, lastSelectedTrackId = "" } = {}) {
  if (!project?.id) return { track: null, binding: null };

  const projectTracks = project.tracks ?? [];
  const activeTrack = activePlayback?.projectId === project.id
    ? projectTracks.find((track) => track.id === activePlayback.trackId)
    : null;
  if (activeTrack) return { track: activeTrack, binding: { type: "playback" } };

  const remembered = projectTracks.find((track) => track.id === lastSelectedTrackId) ?? null;
  const firstPlayable = currentTracks.find((track) => track.managedFileRef || track.managedFilePath) ?? null;
  const track = remembered ?? firstPlayable ?? currentTracks[0] ?? null;
  return track
    ? { track, binding: { type: "preview", projectId: project.id, trackId: track.id, pendingSeekMs: 0 } }
    : { track: null, binding: null };
}

export function resolveFloatingListenTarget({ fallbackProject, fallbackTrack, activePlayback } = {}) {
  if (activePlayback?.project?.id && activePlayback?.track?.id) {
    return {
      project: activePlayback.project,
      track: activePlayback.track,
      binding: { type: "playback" },
    };
  }
  if (fallbackProject?.id && fallbackTrack?.id) {
    return {
      project: fallbackProject,
      track: fallbackTrack,
      binding: {
        type: "preview",
        projectId: fallbackProject.id,
        trackId: fallbackTrack.id,
        pendingSeekMs: 0,
      },
    };
  }
  return { project: null, track: null, binding: null };
}
