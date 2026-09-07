export function nextQueueIndex(currentIndex, queueLength) {
  const nextIndex = currentIndex + 1;
  return nextIndex >= 0 && nextIndex < queueLength ? nextIndex : null;
}

export function repeatQueueIndex(currentIndex, queueLength, repeatMode) {
  if (queueLength <= 0 || currentIndex < 0) return null;
  if (repeatMode === "track") return currentIndex;
  if (repeatMode === "project") return (currentIndex + 1) % queueLength;
  return nextQueueIndex(currentIndex, queueLength);
}

export function shuffleQueue(queue, currentTrackId, seedValue = "opal") {
  const current = queue.find((track) => track.id === currentTrackId);
  const rest = queue.filter((track) => track.id !== currentTrackId).slice();
  let seed = Array.from(`${seedValue}:${currentTrackId ?? ""}`).reduce((value, character) => ((value * 31) + character.charCodeAt(0)) >>> 0, 7);
  for (let index = rest.length - 1; index > 0; index -= 1) {
    seed = (Math.imul(seed ^ (seed >>> 16), 2246822519) + 3266489917) >>> 0;
    const swapIndex = seed % (index + 1);
    [rest[index], rest[swapIndex]] = [rest[swapIndex], rest[index]];
  }
  return current ? [current, ...rest] : rest;
}

export function previousQueueIndex(currentIndex, positionSeconds, queueLength, restartAfterSeconds = 4) {
  if (queueLength <= 0 || currentIndex < 0) return null;
  if (positionSeconds > restartAfterSeconds || currentIndex === 0) return currentIndex;
  return currentIndex - 1;
}

export function isCurrentPlaybackRequest(requestId, activeRequestId) {
  return requestId === activeRequestId;
}
