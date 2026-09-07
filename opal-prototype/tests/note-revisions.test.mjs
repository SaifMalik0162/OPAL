import test from "node:test";
import assert from "node:assert/strict";
import { shouldApplyNoteSave } from "../src/note-revisions.js";
import { createNoteStore, noteKeyParts } from "../src/note-store.js";

const current = {
  currentRevision: 4,
  currentKey: "project-1:project",
  currentDraft: "newer draft",
};

test("applies the response for the current note revision", () => {
  assert.equal(shouldApplyNoteSave({
    requestRevision: 4,
    requestKey: current.currentKey,
    requestText: current.currentDraft,
    ...current,
  }), true);
});

test("ignores an older save response after another draft", () => {
  assert.equal(shouldApplyNoteSave({
    requestRevision: 3,
    requestKey: current.currentKey,
    requestText: "older draft",
    ...current,
  }), false);
});

test("ignores a save response for a previous note context", () => {
  assert.equal(shouldApplyNoteSave({
    requestRevision: 4,
    requestKey: "project-1:track-1",
    requestText: current.currentDraft,
    ...current,
  }), false);
});

test("maps project and track note keys to one backend owner", () => {
  assert.deepEqual(noteKeyParts("project-1:project"), { projectId: "project-1", trackId: null });
  assert.deepEqual(noteKeyParts("project-1:track-1"), { projectId: null, trackId: "track-1" });
});

test("serializes saves and keeps a newer draft after an older save resolves", async () => {
  let journal = null;
  const storage = { getItem: () => journal, setItem: (_key, value) => { journal = value; } };
  const store = createNoteStore(storage);
  const calls = [];
  let releaseFirst;
  let firstStarted;
  const started = new Promise((resolve) => { firstStarted = resolve; });
  const release = new Promise((resolve) => { releaseFirst = resolve; });
  const save = async (key, text) => {
    calls.push([key, text]);
    if (text === "older") {
      firstStarted();
      await release;
    }
  };

  store.edit("project-1:track-1", "older");
  const flushing = store.flush(save);
  await started;
  store.edit("project-1:track-1", "newer");
  releaseFirst();
  await flushing;

  assert.deepEqual(calls, [["project-1:track-1", "older"], ["project-1:track-1", "newer"]]);
  assert.equal(store.get("project-1:track-1"), undefined);
  assert.equal(JSON.parse(journal).length, 0);
});

test("retains the pending draft when a save fails and retries it later", async () => {
  let journal = null;
  const storage = { getItem: () => journal, setItem: (_key, value) => { journal = value; } };
  const store = createNoteStore(storage);
  store.edit("project-1:project", "keep this");
  await assert.rejects(store.flush(async () => { throw new Error("temporary failure"); }));
  assert.equal(store.get("project-1:project"), "keep this");
  assert.deepEqual(JSON.parse(journal), [["project-1:project", "keep this"]]);

  await store.flush(async () => {});
  assert.equal(store.get("project-1:project"), undefined);
  assert.deepEqual(JSON.parse(journal), []);
});
