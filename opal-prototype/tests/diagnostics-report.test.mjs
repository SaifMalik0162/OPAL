import test from "node:test";
import assert from "node:assert/strict";
import { createDiagnosticsReport, serializeDiagnosticsReport } from "../src/diagnostics-report.js";

test("diagnostics report keeps build and database support fields only", () => {
  const report = createDiagnosticsReport({
    appVersion: "0.1.0-alpha.2",
    buildCommit: "a".repeat(40),
    platform: "windows",
    architecture: "x86_64",
    databaseVersion: 7,
    schemaVersion: 7,
    databaseStatus: "open",
    integrity: "ok",
    projectCount: 3,
    trackCount: 11,
    pendingCleanupCount: 1,
    activeImportCount: 0,
    databasePath: "C:\\Users\\Saif\\AppData\\opal.sqlite",
    noteText: "private note content",
  });

  assert.equal(report.buildCommit, "a".repeat(40));
  assert.equal(report.schemaVersion, 7);
  assert.equal("databasePath" in report, false);
  assert.equal("noteText" in report, false);
  assert.equal(JSON.stringify(report).includes("C:\\Users"), false);
  assert.equal(JSON.stringify(report).includes("private note"), false);
});

test("diagnostics errors retain safe summaries and redact unexpected content", () => {
  const serialized = serializeDiagnosticsReport({
    recentErrors: [
      "1794192000000 · Audio import rejected a file",
      "C:\\Users\\Saif\\music\\mix.wav: token=secret",
    ],
  });

  assert.match(serialized, /Audio import rejected a file/);
  assert.match(serialized, /A recent OPAL error occurred/);
  assert.doesNotMatch(serialized, /C:\\\\Users|mix\.wav|secret/);
});
