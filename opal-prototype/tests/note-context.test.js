import test from "node:test";
import assert from "node:assert/strict";
import { createNoteStore } from "../src/note-store.js";
import { createNoteContextManager } from "../src/notes/note-context.js";

function createStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem(key, value) { values.set(key, value); },
  };
}

test("note contexts share one authoritative draft across mounted consumers", () => {
  const journal = createNoteStore(createStorage());
  const manager = createNoteContextManager(journal);
  const updates = [];
  const unsubscribe = manager.subscribe("p:t", () => updates.push(manager.getSnapshot("p:t").text));
  manager.getSnapshot("p:t", "saved");
  manager.update("p:t", "new draft");
  assert.equal(manager.getSnapshot("p:t", "saved").text, "new draft");
  assert.deepEqual(updates, ["new draft"]);
  unsubscribe();
});

test("a delayed save for an older draft does not replace a newer draft", async () => {
  const journal = createNoteStore(createStorage());
  const manager = createNoteContextManager(journal);
  manager.getSnapshot("p:v1", "original");
  manager.update("p:v1", "first");
  let finishSave;
  const saveRecord = () => new Promise((resolve) => { finishSave = () => resolve({ text: "first" }); });
  const saving = manager.persist("p:v1", "first", saveRecord);
  manager.update("p:v1", "second");
  finishSave();
  await saving;
  assert.equal(manager.getSnapshot("p:v1").text, "second");
  assert.equal(manager.getSnapshot("p:v1").persistedText, "first");
  assert.equal(manager.getSnapshot("p:v1").status, "saving");
});

test("a delayed save remains bound to its note key after switching version context", async () => {
  const journal = createNoteStore(createStorage());
  const manager = createNoteContextManager(journal);
  manager.getSnapshot("p:v1", "version one");
  manager.update("p:v1", "saved on version one");
  let finishSave;
  const saving = manager.persist("p:v1", "saved on version one", () => new Promise((resolve) => {
    finishSave = () => resolve({ projectId: "p", trackId: "v1", text: "saved on version one" });
  }));
  manager.getSnapshot("p:v2", "version two");
  manager.update("p:v2", "draft on version two");
  finishSave();
  await saving;
  assert.equal(manager.getSnapshot("p:v1").text, "saved on version one");
  assert.equal(manager.getSnapshot("p:v1").persistedText, "saved on version one");
  assert.equal(manager.getSnapshot("p:v2").text, "draft on version two");
});

test("journal failure is visible to all consumers and does not lose the draft", () => {
  const storage = { getItem: () => null, setItem: () => { throw new Error("disk full"); } };
  const journal = createNoteStore(storage);
  const manager = createNoteContextManager(journal);
  manager.getSnapshot("p:project", "");
  const journalError = manager.update("p:project", "keep this draft");
  assert.ok(journalError instanceof Error);
  assert.equal(manager.getSnapshot("p:project").text, "keep this draft");
  assert.equal(manager.getSnapshot("p:project").status, "error");
});

test("switching project or version returns its own journaled draft", () => {
  const journal = createNoteStore(createStorage());
  const manager = createNoteContextManager(journal);
  manager.getSnapshot("p:v1", "one");
  manager.update("p:v1", "draft one");
  manager.getSnapshot("p:v2", "two");
  manager.update("p:v2", "draft two");
  assert.equal(manager.getSnapshot("p:v1", "one").text, "draft one");
  assert.equal(manager.getSnapshot("p:v2", "two").text, "draft two");
});
