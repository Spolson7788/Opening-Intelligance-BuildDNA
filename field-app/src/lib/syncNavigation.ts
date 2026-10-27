// Tab-local dispatch gate. It does not clear media, cancel an already submitted
// request, or claim that another tab's worker has stopped.
let readOnly = false;
export class SyncNavigationPaused extends Error {
  constructor() { super('sync_navigation_paused'); }
}
export function setSyncReadOnly(value: boolean) { readOnly = value; }
export function assertSyncDispatchAllowed() {
  if (readOnly) throw new SyncNavigationPaused();
}
