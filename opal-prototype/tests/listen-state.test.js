import test from "node:test";
import assert from "node:assert/strict";
import { createInitialListenState, listenStateReducer } from "../src/listen/listen-state.js";

test("carousel surfaces are exclusive and retain project identity", () => {
  let state = createInitialListenState();
  state = listenStateReducer(state, { type: "OPEN_CAROUSEL_SURFACE", surface: "tracks", projectId: "project-a" });
  assert.deepEqual(state.carouselSurface, { type: "tracks", projectId: "project-a" });
  state = listenStateReducer(state, { type: "OPEN_CAROUSEL_SURFACE", surface: "notes", projectId: "project-b" });
  assert.deepEqual(state.carouselSurface, { type: "notes", projectId: "project-b" });
  assert.deepEqual(listenStateReducer(state, { type: "CLOSE_CAROUSEL_SURFACE", projectId: "project-a" }), state);
  assert.deepEqual(listenStateReducer(state, { type: "CLOSE_CAROUSEL_SURFACE" }).carouselSurface, { type: "closed" });
});

test("Listen transitions keep binding separate from transport", () => {
  let state = createInitialListenState();
  state = listenStateReducer(state, { type: "BIND_LISTEN_PREVIEW", projectId: "project-a", trackId: "track-a", pendingSeekMs: 1250 });
  assert.deepEqual(state.listen.binding, { type: "preview", projectId: "project-a", trackId: "track-a", pendingSeekMs: 1250 });
  state = listenStateReducer(state, { type: "OPEN_LISTEN" });
  assert.equal(state.listen.transition, "opening");
  assert.deepEqual(state.listen.binding, { type: "preview", projectId: "project-a", trackId: "track-a", pendingSeekMs: 1250 });
  state = listenStateReducer(state, { type: "LISTEN_OPENED" });
  state = listenStateReducer(state, { type: "CLOSE_LISTEN" });
  assert.equal(state.listen.transition, "closing");
  state = listenStateReducer(state, { type: "LISTEN_CLOSED" });
  assert.equal(state.listen.transition, "closed");
  assert.deepEqual(state.listen.binding, { type: "playback" });
});

test("Listen utilities are mutually exclusive", () => {
  let state = createInitialListenState();
  state = listenStateReducer(state, { type: "OPEN_LISTEN_UTILITY", utility: "queue" });
  state = listenStateReducer(state, { type: "OPEN_LISTEN_UTILITY", utility: "moment-composer" });
  assert.deepEqual(state.listen.utility, { type: "moment-composer" });
  assert.deepEqual(listenStateReducer(state, { type: "CLOSE_LISTEN_UTILITY" }).listen.utility, { type: "closed" });
});
