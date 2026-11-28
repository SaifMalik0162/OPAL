import test from "node:test";
import assert from "node:assert/strict";
import { resolveCarouselListenTarget, resolveFloatingListenTarget } from "../src/listen/listen-target.js";

const project = {
  id: "project-b",
  tracks: [
    { id: "old", managedFilePath: "/old.wav", isCurrent: false },
    { id: "current-missing", isCurrent: true },
    { id: "current-playable", managedFileRef: "managed-3", isCurrent: true },
  ],
};
const currentTracks = [project.tracks[1], project.tracks[2]];

test("carousel Listen binds to that project's active playback track", () => {
  const result = resolveCarouselListenTarget({
    project,
    currentTracks,
    activePlayback: { projectId: project.id, trackId: "old" },
    lastSelectedTrackId: "current-playable",
  });
  assert.equal(result.track.id, "old");
  assert.deepEqual(result.binding, { type: "playback" });
});

test("carousel Listen preserves a valid session selection before current-version fallback", () => {
  const result = resolveCarouselListenTarget({ project, currentTracks, lastSelectedTrackId: "old" });
  assert.equal(result.track.id, "old");
  assert.deepEqual(result.binding, { type: "preview", projectId: "project-b", trackId: "old", pendingSeekMs: 0 });
});

test("carousel Listen skips unplayable current versions when choosing its fallback", () => {
  const result = resolveCarouselListenTarget({ project, currentTracks });
  assert.equal(result.track.id, "current-playable");
});

test("floating player targets actual playback, otherwise the existing display fallback", () => {
  const fallback = resolveFloatingListenTarget({ fallbackProject: project, fallbackTrack: project.tracks[2] });
  assert.equal(fallback.track.id, "current-playable");
  assert.equal(fallback.binding.type, "preview");

  const active = { project, track: project.tracks[0] };
  const playing = resolveFloatingListenTarget({ fallbackProject: project, fallbackTrack: project.tracks[2], activePlayback: active });
  assert.equal(playing.track.id, "old");
  assert.equal(playing.binding.type, "playback");
});
