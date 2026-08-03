export const WEB_ACCOUNT_STATE_LOCK_UNAVAILABLE_MESSAGE =
  "This browser cannot safely coordinate account deletion across open tabs. Update your browser, close other Dofek tabs, and try again.";

const WEB_ACCOUNT_STATE_LOCK_NAME = "dofek-account-state-v1";

export interface WebAccountStateLockLease {
  release(): void;
}

export function webAccountStateLocksAreAvailable(): boolean {
  return !(
    typeof navigator === "undefined" ||
    !("locks" in navigator) ||
    typeof navigator.locks?.request !== "function"
  );
}

export async function acquireWebAccountStateLock(): Promise<WebAccountStateLockLease> {
  if (!webAccountStateLocksAreAvailable()) {
    throw new Error(WEB_ACCOUNT_STATE_LOCK_UNAVAILABLE_MESSAGE);
  }

  let acquired = false;
  let releaseHold: (() => void) | undefined;
  let resolveAcquisition: (() => void) | undefined;
  let rejectAcquisition: ((error: unknown) => void) | undefined;
  const hold = new Promise<void>((resolve) => {
    releaseHold = resolve;
  });
  const acquisition = new Promise<void>((resolve, reject) => {
    resolveAcquisition = resolve;
    rejectAcquisition = reject;
  });
  const request = navigator.locks.request(
    WEB_ACCOUNT_STATE_LOCK_NAME,
    { mode: "exclusive" },
    async () => {
      acquired = true;
      resolveAcquisition?.();
      await hold;
    },
  );
  void request.catch((error: unknown) => {
    if (!acquired) {
      rejectAcquisition?.(error);
    }
  });

  await acquisition;
  let released = false;
  return {
    release: () => {
      if (released) return;
      released = true;
      releaseHold?.();
    },
  };
}

export async function withWebAccountStateLock<T>(operation: () => Promise<T>): Promise<T> {
  const lease = await acquireWebAccountStateLock();
  try {
    return await operation();
  } finally {
    lease.release();
  }
}

export function withWebAccountStateLockWhenAvailable<T>(operation: () => Promise<T>): Promise<T> {
  return webAccountStateLocksAreAvailable() ? withWebAccountStateLock(operation) : operation();
}
