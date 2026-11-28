export async function flushBeforeNoteTransition({ cancelDebounce, flush, commit, onFailure }) {
  cancelDebounce?.();
  try {
    if (!(await flush())) {
      onFailure?.();
      return false;
    }
  } catch {
    onFailure?.();
    return false;
  }
  commit?.();
  return true;
}
