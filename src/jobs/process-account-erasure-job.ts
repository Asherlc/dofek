export const ACCOUNT_ERASURE_CRITICAL_PHASES = [
  "ingest_fence",
  "stripe_erasure",
  "work_purge",
  "consumer_drain",
] as const;

export const ACCOUNT_ERASURE_INITIAL_PHASES = [
  "remote_revocation",
  "processor_erasure",
  "postgres_erasure",
  "clickhouse_initial",
  "archive_initial",
] as const;

export const ACCOUNT_ERASURE_VERIFICATION_PHASES = [
  "work_verification",
  "consumer_drain_verification",
  "stripe_erasure_verification",
  "remote_revocation_verification",
  "processor_erasure_verification",
  "postgres_profile_delete",
  "peerdb_drain_verification",
  "clickhouse_verification",
  "archive_verification",
  "request_pii_scrub",
] as const;

export const ACCOUNT_ERASURE_RETENTION_PHASES = ["retention_verification"] as const;

const ACCOUNT_ERASURE_RETENTION_VERIFICATION_WINDOW_MS = 29 * 24 * 60 * 60 * 1_000;

export function accountErasureRetentionVerificationAt(requestedAt: Date): Date {
  return new Date(requestedAt.getTime() + ACCOUNT_ERASURE_RETENTION_VERIFICATION_WINDOW_MS);
}

export const ACCOUNT_ERASURE_ACTIVE_PHASES = [
  ...ACCOUNT_ERASURE_CRITICAL_PHASES,
  ...ACCOUNT_ERASURE_INITIAL_PHASES,
  ...ACCOUNT_ERASURE_VERIFICATION_PHASES,
  ...ACCOUNT_ERASURE_RETENTION_PHASES,
] as const;

export type AccountErasurePhase = (typeof ACCOUNT_ERASURE_ACTIVE_PHASES)[number];

export interface AccountErasureRequest {
  id: string;
  requestedAt: Date;
  replayRetainedUntil: Date;
  retentionVerificationAt: Date;
  userId: string | null;
}

export interface AccountErasureJobDependencies {
  finalize(request: AccountErasureRequest, completedAt: Date): Promise<void>;
  loadCompletedPhases(requestId: string): Promise<ReadonlySet<string>>;
  markCompleted(
    requestId: string,
    phase: AccountErasurePhase,
    details: Record<string, unknown> | null,
  ): Promise<void>;
  markWaiting(requestId: string, retryAt: Date, reason: "replay" | "retention"): Promise<void>;
  runPhase(
    phase: AccountErasurePhase,
    request: AccountErasureRequest,
  ): Promise<Record<string, unknown> | null>;
}

export type AccountErasureJobResult =
  | { status: "completed" }
  | {
      retryAt: Date;
      status: "waiting";
      waitReason: "replay" | "retention";
    };

async function runPendingPhases(
  request: AccountErasureRequest,
  dependencies: AccountErasureJobDependencies,
  completed: Set<string>,
  phases: readonly AccountErasurePhase[],
): Promise<void> {
  const failures: unknown[] = [];
  for (const phase of phases) {
    if (completed.has(phase)) continue;
    try {
      const details = await dependencies.runPhase(phase, request);
      await dependencies.markCompleted(request.id, phase, details);
      completed.add(phase);
    } catch (error: unknown) {
      failures.push(error);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(failures, "One or more account erasure effects failed");
  }
}

async function runPhaseStrictly(
  request: AccountErasureRequest,
  dependencies: AccountErasureJobDependencies,
  completed: Set<string>,
  phase: AccountErasurePhase,
): Promise<void> {
  if (completed.has(phase)) return;
  const details = await dependencies.runPhase(phase, request);
  await dependencies.markCompleted(request.id, phase, details);
  completed.add(phase);
}

async function runQuiescencePhase(
  request: AccountErasureRequest,
  dependencies: AccountErasureJobDependencies,
  completed: Set<string>,
  phase: "work_purge" | "consumer_drain",
  checkpoint: boolean,
): Promise<void> {
  if (checkpoint) {
    await runPhaseStrictly(request, dependencies, completed, phase);
    return;
  }
  await dependencies.runPhase(phase, request);
}

export async function processAccountErasureJob(
  request: AccountErasureRequest,
  dependencies: AccountErasureJobDependencies,
  now = new Date(),
): Promise<AccountErasureJobResult> {
  const completed = new Set(await dependencies.loadCompletedPhases(request.id));
  const initialFailures: unknown[] = [];
  let ingestIsFenced = completed.has("ingest_fence");
  try {
    await runPhaseStrictly(request, dependencies, completed, "ingest_fence");
    ingestIsFenced = true;
  } catch (error: unknown) {
    initialFailures.push(error);
  }

  try {
    await runPhaseStrictly(request, dependencies, completed, "stripe_erasure");
  } catch (error: unknown) {
    initialFailures.push(error);
  }

  let workIsQuiescent = true;
  try {
    await runQuiescencePhase(request, dependencies, completed, "work_purge", ingestIsFenced);
  } catch (error: unknown) {
    workIsQuiescent = false;
    initialFailures.push(error);
  }
  try {
    await runQuiescencePhase(request, dependencies, completed, "consumer_drain", ingestIsFenced);
  } catch (error: unknown) {
    workIsQuiescent = false;
    initialFailures.push(error);
  }

  if (ingestIsFenced && workIsQuiescent) {
    try {
      await runPendingPhases(request, dependencies, completed, ACCOUNT_ERASURE_INITIAL_PHASES);
    } catch (error: unknown) {
      initialFailures.push(error);
    }
  }
  if (initialFailures.length > 0) {
    throw new AggregateError(initialFailures, "One or more initial account erasure effects failed");
  }

  if (now < request.replayRetainedUntil) {
    await dependencies.markWaiting(request.id, request.replayRetainedUntil, "replay");
    return {
      retryAt: request.replayRetainedUntil,
      status: "waiting",
      waitReason: "replay",
    };
  }

  await runPhaseStrictly(request, dependencies, completed, "work_verification");
  await runPhaseStrictly(request, dependencies, completed, "consumer_drain_verification");
  await runPendingPhases(request, dependencies, completed, [
    "stripe_erasure_verification",
    "remote_revocation_verification",
    "processor_erasure_verification",
  ]);
  await runPhaseStrictly(request, dependencies, completed, "postgres_profile_delete");
  await runPhaseStrictly(request, dependencies, completed, "peerdb_drain_verification");
  await runPendingPhases(request, dependencies, completed, [
    "clickhouse_verification",
    "archive_verification",
  ]);
  await runPhaseStrictly(request, dependencies, completed, "request_pii_scrub");
  if (now < request.retentionVerificationAt) {
    await dependencies.markWaiting(request.id, request.retentionVerificationAt, "retention");
    return {
      retryAt: request.retentionVerificationAt,
      status: "waiting",
      waitReason: "retention",
    };
  }
  await runPhaseStrictly(request, dependencies, completed, "retention_verification");
  await dependencies.finalize(request, now);
  return { status: "completed" };
}
