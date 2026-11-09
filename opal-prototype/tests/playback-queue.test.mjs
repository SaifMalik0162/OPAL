import test from "node:test";
import assert from "node:assert/strict";
import { isCurrentPlaybackRequest, nextQueueIndex, previousQueueIndex, repeatQueueIndex, shuffleQueue } from "../src/playback-queue.js";
import { reconcilePlayingQueue } from "../src/queue-state.js";
import { remainingGapMilliseconds } from "../src/playback-gap.js";

test("queue advances until the final track, then stops", () => {
  assert.equal(nextQueueIndex(0, 3), 1);
  assert.equal(nextQueueIndex(2, 3), null);
});

test("previous restarts after the threshold and otherwise moves back", () => {
  assert.equal(previousQueueIndex(2, 4.1, 3), 2);
  assert.equal(previousQueueIndex(2, 4, 3), 1);
  assert.equal(previousQueueIndex(0, 1, 3), 0);
});

test("sequence gap pause captures only the time that remains", () => {
  assert.equal(remainingGapMilliseconds(1_500, 1_000), 500);
  assert.equal(remainingGapMilliseconds(1_500, 1_501), 0);
  assert.equal(remainingGapMilliseconds(null, 1_000), 0);
});

test("stale audio events are rejected after a track switch", () => {
  assert.equal(isCurrentPlaybackRequest(8, 8), true);
  assert.equal(isCurrentPlaybackRequest(7, 8), false);
});

test("repeat modes loop the track or project without changing the queue shape", () => {
  assert.equal(repeatQueueIndex(1, 3, "track"), 1);
  assert.equal(repeatQueueIndex(2, 3, "project"), 0);
  assert.equal(repeatQueueIndex(2, 3, "off"), null);
});

test("shuffle keeps the chosen track first and is stable for the same seed", () => {
  const queue = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
  const first = shuffleQueue(queue, "c", "project");
  const second = shuffleQueue(queue, "c", "project");
  assert.deepEqual(first, second);
  assert.equal(first[0].id, "c");
  assert.equal(new Set(first.map((track) => track.id)).size, queue.length);
});

test("project edits and imports refresh the active queue without changing the current track", () => {
  const first = { id: "one", title: "One" };
  const second = { id: "two", title: "Two" };
  const updatedProject = { id: "project", title: "Updated", tracks: [first, second, { id: "three", title: "Three" }] };
  const playback = { project: { id: "project", title: "Original" }, projectId: "project", trackId: "two", queue: [first, second], index: 1 };

  const next = reconcilePlayingQueue(playback, updatedProject);

  assert.equal(next.project.title, "Updated");
  assert.deepEqual(next.queue, updatedProject.tracks);
  assert.equal(next.index, 1);
  assert.equal(next.trackId, "two");
});

test("reordering and deleting another track follow the active track by stable id", () => {
  const updatedProject = { id: "project", tracks: [{ id: "three" }, { id: "one" }, { id: "two" }] };
  const playback = { project: { id: "project" }, projectId: "project", trackId: "two", queue: [], index: 0 };

  const next = reconcilePlayingQueue(playback, updatedProject);

  assert.equal(next.index, 2);
  assert.equal(next.queue[0].id, "three");
});

test("a missing active track is surfaced to the caller instead of silently retargeting playback", () => {
  const playback = { project: { id: "project" }, projectId: "project", trackId: "missing", queue: [], index: 0 };
  const next = reconcilePlayingQueue(playback, { id: "project", tracks: [] });

  assert.equal(next.index, -1);
  assert.equal(next.trackId, "missing");
});

test("version rows collapse to the current version while preserving an active A/B version", () => {
  const original = { id: "original", groupId: "group", position: 0, versionPosition: 0, isCurrent: false };
  const bounce = { id: "bounce", groupId: "group", position: 0, versionPosition: 1, isCurrent: true };
  const next = reconcilePlayingQueue(
    { project: { id: "project" }, projectId: "project", trackId: "original", queue: [original], index: 0 },
    { id: "project", tracks: [original, bounce] },
  );

  assert.equal(next.queue.length, 1);
  assert.equal(next.queue[0].id, "original");
  assert.equal(next.index, 0);
});
