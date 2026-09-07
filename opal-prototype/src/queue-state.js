export function reconcilePlayingQueue(playback, nextProject) {
  if (!playback?.project || !nextProject || playback.projectId !== nextProject.id) return playback;

  const index = nextProject.tracks.findIndex((track) => track.id === playback.trackId);
  return {
    ...playback,
    project: nextProject,
    queue: nextProject.tracks,
    index,
  };
}
