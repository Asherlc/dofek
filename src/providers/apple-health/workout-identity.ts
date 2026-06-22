/** Shared identity for deduplicating Apple Health workouts that share one real activity. */

export const APPLE_HEALTH_PROVIDER_ID = "apple_health";

export interface AppleHealthWorkoutIdentityInput {
  syncIdentifier?: string | number | null;
  startedAt: Date;
  endedAt: Date;
  sourceName?: string | null;
}

export interface AppleHealthWorkoutIdentity {
  syncIdentifier: string | null;
  startedAt: Date;
  endedAt: Date;
  sourceName: string;
}

function normalizeSyncIdentifier(value: string | number | null | undefined): string | null {
  if (value == null) return null;
  const normalized = String(value).trim();
  return normalized === "" ? null : normalized;
}

/** Builds the identity used to match duplicate Apple Health workouts from one upstream app. */
export function buildAppleHealthWorkoutIdentity(
  input: AppleHealthWorkoutIdentityInput,
): AppleHealthWorkoutIdentity {
  return {
    syncIdentifier: normalizeSyncIdentifier(input.syncIdentifier),
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    sourceName: input.sourceName?.trim() ?? "",
  };
}

/** Stable logical key for duplicate chains (matches fitness.v_activity SQL). */
export function appleHealthWorkoutLogicalKey(identity: AppleHealthWorkoutIdentity): string {
  if (identity.syncIdentifier) {
    return `sync:${identity.syncIdentifier}`;
  }
  return `time:${identity.startedAt.toISOString()}:${identity.endedAt.toISOString()}:${identity.sourceName}`;
}

export function collectAppleHealthWorkoutIdentities(
  workouts: readonly AppleHealthWorkoutIdentityInput[],
): AppleHealthWorkoutIdentity[] {
  const byKey = new Map<string, AppleHealthWorkoutIdentity>();
  for (const workout of workouts) {
    const identity = buildAppleHealthWorkoutIdentity(workout);
    byKey.set(appleHealthWorkoutLogicalKey(identity), identity);
  }
  return [...byKey.values()];
}
