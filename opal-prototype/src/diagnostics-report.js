const safeErrorSummaries = new Set([
  "Library storage is unavailable",
  "Library integrity check failed",
  "Library database could not be opened",
  "Audio import rejected a file",
  "Audio waveform analysis failed",
  "Library restore failed",
  "Startup recovery is required",
]);

export function createDiagnosticsReport(diagnostics = {}) {
  const recentErrors = Array.isArray(diagnostics.recentErrors)
    ? diagnostics.recentErrors.slice(-12).map(redactError)
    : [];

  return {
    appVersion: safeText(diagnostics.appVersion),
    buildCommit: safeCommit(diagnostics.buildCommit),
    platform: safeText(diagnostics.platform),
    architecture: safeText(diagnostics.architecture),
    databaseVersion: safeNumber(diagnostics.databaseVersion),
    schemaVersion: safeNumber(diagnostics.schemaVersion),
    databaseStatus: safeStatus(diagnostics.databaseStatus, ["open", "busy", "unavailable"]),
    integrity: safeStatus(diagnostics.integrity, ["ok", "failed", "unavailable"]),
    projectCount: safeCount(diagnostics.projectCount),
    trackCount: safeCount(diagnostics.trackCount),
    pendingCleanupCount: safeCount(diagnostics.pendingCleanupCount),
    activeImportCount: safeCount(diagnostics.activeImportCount),
    recentErrors,
  };
}

export function serializeDiagnosticsReport(diagnostics) {
  return JSON.stringify(createDiagnosticsReport(diagnostics), null, 2);
}

function redactError(value) {
  if (typeof value !== "string") return "A recent OPAL error occurred.";
  const separator = value.lastIndexOf(" · ");
  const timestamp = separator < 0 ? "" : value.slice(0, separator);
  const summary = separator < 0 ? value : value.slice(separator + 3);
  if (!safeErrorSummaries.has(summary)) return "A recent OPAL error occurred.";
  return /^\d{10,16}$/.test(timestamp) ? `${timestamp} · ${summary}` : summary;
}

function safeText(value) {
  return typeof value === "string" && value.length <= 100 ? value : "Unavailable";
}

function safeCommit(value) {
  return typeof value === "string" && /^(?:[0-9a-f]{7,40}|unknown)$/i.test(value) ? value : "unknown";
}

function safeStatus(value, allowed) {
  return allowed.includes(value) ? value : "unavailable";
}

function safeNumber(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function safeCount(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}
