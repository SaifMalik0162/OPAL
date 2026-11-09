const JOURNAL_KEY = "opal.pending-notes.v1";

function safeStorage(storage) {
  return storage ?? { getItem: () => null, setItem: () => {} };
}

function readDrafts(storage) {
  try {
    const value = JSON.parse(storage.getItem(JOURNAL_KEY) ?? "[]");
    return new Map(Array.isArray(value)
      ? value.filter((entry) => Array.isArray(entry) && entry.length === 2 && typeof entry[0] === "string" && typeof entry[1] === "string")
      : []);
  } catch {
    return new Map();
  }
}

export function noteKeyParts(key) {
  const separator = key.indexOf(":");
  if (separator < 1 || separator === key.length - 1) throw new Error("Invalid OPAL note key.");
  const projectId = key.slice(0, separator);
  const targetId = key.slice(separator + 1);
  return {
    projectId: targetId === "project" ? projectId : null,
    trackId: targetId === "project" ? null : targetId,
  };
}

export function createNoteStore(storage) {
  const journal = safeStorage(storage);
  const drafts = readDrafts(journal);
  let tail = Promise.resolve();
  let journalError = null;

  function writeJournal() {
    try {
      journal.setItem(JOURNAL_KEY, JSON.stringify([...drafts.entries()]));
      journalError = null;
    } catch {
      journalError = new Error("OPAL could not save a local recovery copy of this note.");
    }
  }

  return {
    get(key) {
      return drafts.get(key);
    },
    getJournalError() {
      return journalError;
    },
    edit(key, text) {
      drafts.set(key, text);
      writeJournal();
    },
    remove(key) {
      if (drafts.delete(key)) writeJournal();
    },
    removePrefix(prefix) {
      let changed = false;
      for (const key of drafts.keys()) {
        if (key.startsWith(prefix)) changed = drafts.delete(key) || changed;
      }
      if (changed) writeJournal();
    },
    entries() {
      return [...drafts.entries()];
    },
    flush(save) {
      const run = async () => {
        while (drafts.size) {
          const snapshot = [...drafts.entries()];
          for (const [key, text] of snapshot) {
            await save(key, text);
            if (drafts.get(key) === text) {
              drafts.delete(key);
              writeJournal();
            }
          }
        }
      };
      tail = tail.catch(() => {}).then(run);
      return tail;
    },
  };
}
