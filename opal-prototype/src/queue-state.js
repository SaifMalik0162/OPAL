function currentQueue(project, preferredTrackId = "") {
  const groups = new Map();
  (project?.tracks ?? []).forEach((track) => {
    const groupId = track.groupId ?? track.id;
    const group = groups.get(groupId) ?? { position: track.position ?? groups.size, tracks: [] };
    group.tracks.push(track);
    groups.set(groupId, group);
  });
  const queue = Array.from(groups.values())
    .sort((left, right) => left.position - right.position)
    .map((group) => group.tracks.find((track) => track.isCurrent) ?? group.tracks[0])
    .filter(Boolean);
  const preferred = project?.tracks.find((track) => track.id === preferredTrackId);
  if (!preferred) return queue;
  const groupId = preferred.groupId ?? preferred.id;
  const index = queue.findIndex((track) => (track.groupId ?? track.id) === groupId);
  if (index >= 0) queue[index] = preferred;
  else queue.push(preferred);
  return queue;
}

export function reconcilePlayingQueue(playback, nextProject) {
  if (!playback?.project || !nextProject || playback.projectId !== nextProject.id) return playback;

  const queue = currentQueue(nextProject, playback.trackId);
  const index = queue.findIndex((track) => track.id === playback.trackId);
  return {
    ...playback,
    project: nextProject,
    queue,
    index,
  };
}
