export interface HealthServiceDependencies {
  queryPermission(): number;
  requestPermission(): Promise<number>;
  startService(): void;
}

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
