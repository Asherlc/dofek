import { AsyncLocalStorage } from "node:async_hooks";

type SyncStepAdmissionState = {
  admitted: boolean;
};

const syncStepAdmissionContext = new AsyncLocalStorage<SyncStepAdmissionState>();

/** Runs a sync step (e.g. one BullMQ job phase) with its own adaptive rate-limit budget. */
export function runWithSyncStepAdmission<T>(fn: () => T): T {
  return syncStepAdmissionContext.run({ admitted: false }, fn);
}

export function isInsideSyncStepAdmission(): boolean {
  return syncStepAdmissionContext.getStore() !== undefined;
}

export function hasSyncStepAdmissionClaimed(): boolean {
  return syncStepAdmissionContext.getStore()?.admitted ?? false;
}

export function markSyncStepAdmissionClaimed(): void {
  const state = syncStepAdmissionContext.getStore();
  if (state) state.admitted = true;
}

/** Claims the sync-step budget slot for the current caller; returns false if already claimed. */
export function tryClaimSyncStepAdmission(): boolean {
  const state = syncStepAdmissionContext.getStore();
  if (!state || state.admitted) return false;
  state.admitted = true;
  return true;
}
