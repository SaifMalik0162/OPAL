import test from "node:test";
import assert from "node:assert/strict";
import { flushBeforeNoteTransition } from "../src/notes/safe-transition.js";

test("note transitions cancel debounce, flush, then commit", async () => {
  const calls = [];
  const committed = await flushBeforeNoteTransition({
    cancelDebounce: () => calls.push("cancel"),
    flush: async () => { calls.push("flush"); return true; },
    commit: () => calls.push("commit"),
  });
  assert.equal(committed, true);
  assert.deepEqual(calls, ["cancel", "flush", "commit"]);
});

test("failed note transitions keep the editor open and expose retry", async () => {
  const calls = [];
  const committed = await flushBeforeNoteTransition({
    cancelDebounce: () => calls.push("cancel"),
    flush: async () => false,
    commit: () => calls.push("commit"),
    onFailure: () => calls.push("retry"),
  });
  assert.equal(committed, false);
  assert.deepEqual(calls, ["cancel", "retry"]);
});
