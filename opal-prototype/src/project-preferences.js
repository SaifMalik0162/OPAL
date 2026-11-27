const SORT_MODES = new Set(["manual", "alphabetical", "fileCreated", "fileModified"]);
const DEFAULTS = Object.freeze({ sortMode: "manual", sortDirection: "asc", section: "tracks" });

function preferenceKey(projectId) {
  return `opal.project-view.v1.${projectId}`;
}

export function readProjectPreference(projectId, storage) {
  try {
    storage ??= window.localStorage;
    const value = JSON.parse(storage.getItem(preferenceKey(projectId)));
    return {
      sortMode: SORT_MODES.has(value?.sortMode) ? value.sortMode : DEFAULTS.sortMode,
      sortDirection: value?.sortDirection === "desc" ? "desc" : "asc",
      section: value?.section === "notes" ? "notes" : "tracks",
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeProjectPreference(projectId, patch, storage) {
  try {
    storage ??= window.localStorage;
    storage.setItem(preferenceKey(projectId), JSON.stringify({
      ...readProjectPreference(projectId, storage),
      ...patch,
    }));
    return true;
  } catch {
    return false;
  }
}

export function sortProjectGroups(groups, mode, direction) {
  if (mode === "manual") return [...groups];
  const sign = direction === "desc" ? -1 : 1;
  return [...groups].sort((a, b) => {
    if (mode === "alphabetical") {
      return sign * a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
    }
    const field = mode === "fileCreated" ? "fileCreatedAt" : "fileModifiedAt";
    // Unknown source dates stay at the end in both directions.
    if (a[field] == null) return b[field] == null ? 0 : 1;
    if (b[field] == null) return -1;
    return sign * (a[field] - b[field]);
  });
}
