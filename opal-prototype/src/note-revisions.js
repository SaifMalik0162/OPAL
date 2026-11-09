export function shouldApplyNoteSave({ requestRevision, currentRevision, requestKey, currentKey, requestText, currentDraft }) {
  return requestRevision === currentRevision && requestKey === currentKey && requestText === currentDraft;
}
