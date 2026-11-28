import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

export function useNoteContext({ manager, key, persistedText = "", onDebouncedSave, onJournalError, journalDraft = true }) {
  const saveRef = useRef(onDebouncedSave);
  const errorRef = useRef(onJournalError);
  const timerRef = useRef(null);
  saveRef.current = onDebouncedSave;
  errorRef.current = onJournalError;

  const subscribe = useCallback((listener) => manager.subscribe(key, listener), [manager, key]);
  const getSnapshot = useCallback(() => manager.getSnapshot(key, persistedText), [manager, key, persistedText]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  useEffect(() => {
    manager.setPersisted(key, persistedText);
  }, [manager, key, persistedText]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, [key]);

  const cancelDebounce = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  const update = useCallback((text) => {
    if (!key) return;
    const journalError = manager.update(key, text, { journalDraft });
    if (journalError) errorRef.current?.(journalError);
    if (!journalDraft || text === manager.getSnapshot(key, persistedText).persistedText) {
      cancelDebounce();
      return;
    }
    cancelDebounce();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      void saveRef.current?.();
    }, 650);
  }, [cancelDebounce, journalDraft, key, manager, persistedText]);

  return { ...snapshot, update, cancelDebounce };
}
