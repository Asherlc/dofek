export interface HealthServiceDependencies {
  queryPermission(): number;
  requestPermission(): Promise<number>;
  startService(): void;
}

export interface ForegroundHealthOwnershipDependencies {
  queryPermission(): number;
  requestPermission(): Promise<number>;
  stopService(): Promise<void>;
  startService(): void;
}

export type ForegroundHealthOwnership = {
  state: "acquired" | "permission-denied";
  reason?: string;
  release(): void;
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

  dependencies.startService();
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
      release() {},
    };
  }

  await dependencies.stopService();
  let released = false;
  return {
    state: "acquired",
    release() {
      if (released) return;
      released = true;
      dependencies.startService();
    },
  };
}
