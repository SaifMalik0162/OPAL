import { shouldApplyNoteSave } from "../note-revisions.js";

function makeSnapshot(record) {
  return {
    text: record.draftText,
    persistedText: record.persistedText,
    status: record.status,
    revision: record.revision,
  };
}

export function createNoteContextManager(journal) {
  const contexts = new Map();
  const listeners = new Map();

  function notify(key) {
    const record = contexts.get(key);
    if (!record) return;
    record.snapshot = makeSnapshot(record);
    for (const listener of listeners.get(key) ?? []) listener();
  }

  function ensure(key, persistedText = "") {
    if (!key) return null;
    const record = contexts.get(key);
    if (record) return record;
    const pendingText = journal.get(key);
    const savedText = typeof persistedText === "string" ? persistedText : "";
    const draftText = pendingText ?? savedText;
    const next = {
      draftText,
      persistedText: savedText,
      revision: 0,
      invalidatedRevision: -1,
      status: pendingText !== undefined && pendingText !== savedText ? "saving" : "saved",
      snapshot: null,
    };
    next.snapshot = makeSnapshot(next);
    contexts.set(key, next);
    return next;
  }

  return {
    getSnapshot(key, persistedText = "") {
      return ensure(key, persistedText)?.snapshot ?? { text: "", persistedText: "", status: "saved", revision: 0 };
    },
    subscribe(key, listener) {
      if (!key) return () => {};
      ensure(key);
      const subscribers = listeners.get(key) ?? new Set();
      subscribers.add(listener);
      listeners.set(key, subscribers);
      return () => {
        subscribers.delete(listener);
        if (!subscribers.size) listeners.delete(key);
      };
    },
    setPersisted(key, persistedText) {
      if (!key || typeof persistedText !== "string") return;
      const record = ensure(key, persistedText);
      if (record.persistedText === persistedText) return;
      record.persistedText = persistedText;
      if (record.draftText === record.snapshot.text && record.draftText === record.persistedText) {
        record.status = "saved";
      } else if (record.draftText === record.snapshot.persistedText && journal.get(key) === undefined) {
        record.draftText = persistedText;
        record.status = "saved";
        record.revision += 1;
      }
      notify(key);
    },
    remove(key) {
      journal.remove(key);
      const record = contexts.get(key);
      if (!record) return;
      record.draftText = "";
      record.persistedText = "";
      record.revision += 1;
      record.invalidatedRevision = record.revision;
      record.status = "saved";
      notify(key);
    },
    removePrefix(prefix) {
      journal.removePrefix(prefix);
      for (const key of contexts.keys()) {
        if (!key.startsWith(prefix)) continue;
        const record = contexts.get(key);
        record.draftText = "";
        record.persistedText = "";
        record.revision += 1;
        record.invalidatedRevision = record.revision;
        record.status = "saved";
        notify(key);
      }
    },
    update(key, text, { journalDraft = true } = {}) {
      if (!key) return null;
      const record = ensure(key);
      if (record.draftText === text) return journal.getJournalError();
      record.draftText = text;
      record.revision += 1;
      if (journalDraft && text !== record.persistedText) {
        journal.edit(key, text);
        record.status = journal.getJournalError() ? "error" : "saving";
      } else {
        if (journalDraft && text === record.persistedText) journal.remove(key);
        record.status = "saved";
      }
      notify(key);
      return journalDraft ? journal.getJournalError() : null;
    },
    async persist(key, text, saveRecord, onSaved) {
      const record = ensure(key);
      const requestRevision = record.revision;
      try {
        const saved = await saveRecord(key, text);
        if (contexts.get(key) !== record) return saved;
        if (requestRevision <= record.invalidatedRevision) return saved;
        onSaved?.(saved);
        record.persistedText = text;
        const isCurrent = shouldApplyNoteSave({
          requestRevision,
          currentRevision: record.revision,
          requestKey: key,
          currentKey: key,
          requestText: text,
          currentDraft: record.draftText,
        });
        record.status = isCurrent ? "saved" : (journal.getJournalError() ? "error" : "saving");
        notify(key);
        return saved;
      } catch (error) {
        record.status = "error";
        notify(key);
        throw error;
      }
    },
  };
}
