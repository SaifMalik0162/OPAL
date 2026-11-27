import test from "node:test";
import assert from "node:assert/strict";
import { readProjectPreference, writeProjectPreference, sortProjectGroups } from "./project-preferences.js";

function memoryStorage() {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
}

test("preferences survive reopening and stay separate per project", () => {
  const storage = memoryStorage();
  writeProjectPreference("one", { sortMode: "fileModified", sortDirection: "desc" }, storage);
  writeProjectPreference("one", { section: "notes" }, storage);
  writeProjectPreference("two", { sortMode: "alphabetical" }, storage);
  assert.deepEqual(readProjectPreference("one", storage), { sortMode: "fileModified", sortDirection: "desc", section: "notes" });
  assert.deepEqual(readProjectPreference("two", storage), { sortMode: "alphabetical", sortDirection: "asc", section: "tracks" });
});

test("invalid or unavailable storage falls back safely", () => {
  const broken = { getItem() { throw new Error("blocked"); }, setItem() { throw new Error("blocked"); } };
  assert.deepEqual(readProjectPreference("one", broken), { sortMode: "manual", sortDirection: "asc", section: "tracks" });
  assert.equal(writeProjectPreference("one", { section: "notes" }, broken), false);
  const storage = memoryStorage();
  storage.setItem("opal.project-view.v1.one", '{"sortMode":"bad","sortDirection":"bad","section":"bad"}');
  assert.deepEqual(readProjectPreference("one", storage), { sortMode: "manual", sortDirection: "asc", section: "tracks" });
});

test("date directions keep unknown dates last and ties in manual order", () => {
  const groups = [
    { title: "Unknown", fileCreatedAt: null, fileModifiedAt: null },
    { title: "New", fileCreatedAt: 30, fileModifiedAt: 10 },
    { title: "Old", fileCreatedAt: 0, fileModifiedAt: 40 },
    { title: "Same", fileCreatedAt: 30, fileModifiedAt: 10 },
  ];
  const names = (mode, direction) => sortProjectGroups(groups, mode, direction).map((group) => group.title);
  assert.deepEqual(names("fileCreated", "asc"), ["Old", "New", "Same", "Unknown"]);
  assert.deepEqual(names("fileCreated", "desc"), ["New", "Same", "Old", "Unknown"]);
  assert.deepEqual(names("fileModified", "desc"), ["Old", "New", "Same", "Unknown"]);
  assert.deepEqual(names("alphabetical", "asc"), ["New", "Old", "Same", "Unknown"]);
  assert.deepEqual(names("alphabetical", "desc"), ["Unknown", "Same", "Old", "New"]);
  assert.deepEqual(sortProjectGroups(groups, "manual", "desc"), groups);
  assert.equal(groups[0].title, "Unknown");
});
