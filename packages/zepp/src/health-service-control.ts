export interface HealthServiceDependencies {
  queryPermission(): number;
  requestPermission(): Promise<number>;
  startService(): void | Promise<void>;
}

export interface ForegroundHealthOwnershipDependencies {
  queryPermission(): number;
  requestPermission(): Promise<number>;
  stopService(): Promise<void>;
  startService(): void | Promise<void>;
}

export type ForegroundHealthOwnership = {
  state: "acquired" | "permission-denied";
  reason?: string;
  release(afterMutation?: Promise<unknown>): Promise<void>;
};

export type HealthServiceStartResult =
  | { state: "started" }
  | { state: "permission-denied"; reason: string };

const PERMISSION_DENIED_REASON =
  "Background health collection requires Background Service permission.";

export async function ensureHealthServiceRunning(
  dependencies: HealthServiceDependencies,
): Promise<HealthServiceStartResult> {
  const currentPermission = dependencies.queryPermission();
  const permission =
    currentPermission === 2 ? currentPermission : await dependencies.requestPermission();
  if (permission !== 2) {
    return { state: "permission-denied", reason: PERMISSION_DENIED_REASON };
  }

  await dependencies.startService();
  return { state: "started" };
}

export async function acquireForegroundHealthOwnership(
  dependencies: ForegroundHealthOwnershipDependencies,
): Promise<ForegroundHealthOwnership> {
  const currentPermission = dependencies.queryPermission();
  const permission =
    currentPermission === 2 ? currentPermission : await dependencies.requestPermission();
  if (permission !== 2) {
    return {
      state: "permission-denied",
      reason: PERMISSION_DENIED_REASON,
      async release() {},
    };
  }

  await dependencies.stopService();
  let released = false;
  let releaseTask: Promise<void> | null = null;
  return {
    state: "acquired",
    release(afterMutation) {
      if (releaseTask) return releaseTask;
      if (released) return Promise.resolve();
      released = true;
      if (!afterMutation) {
        const pendingRelease = Promise.resolve(dependencies.startService()).then(() => undefined);
        releaseTask = pendingRelease;
        return pendingRelease;
      }
      const pendingRelease = restartAfterMutation(afterMutation, dependencies.startService);
      releaseTask = pendingRelease;
      return pendingRelease;
    },
  };
}

async function restartAfterMutation(
  mutation: Promise<unknown>,
  startService: () => void | Promise<void>,
): Promise<void> {
  const noError = Symbol("no-error");
  let mutationError: unknown = noError;
  try {
    await mutation;
  } catch (error) {
    mutationError = error;
  }
  try {
    await startService();
  } catch (restartError) {
    if (mutationError !== noError) {
      throw new AggregateError(
        [mutationError, restartError],
        "Foreground health mutation and App Service restart both failed.",
        { cause: mutationError },
      );
    }
    throw restartError;
  }
  if (mutationError !== noError) throw mutationError;
}
