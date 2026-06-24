import { createHash } from "node:crypto";
import type { SyncJobData } from "../jobs/queues.ts";
import { syncWindowFromJobData } from "../jobs/sync-job-window.ts";
import { type SyncApiQuery, syncApiQueryKey } from "./sync-api-query.ts";

export type SyncRequestQueryResolver = (jobData: SyncJobData) => SyncApiQuery | null;

const syncRequestQueryResolvers = new Map<string, SyncRequestQueryResolver>();

export function registerSyncRequestQueryResolver(
  providerId: string,
  resolver: SyncRequestQueryResolver,
): void {
  if (syncRequestQueryResolvers.has(providerId)) {
    throw new Error(`Sync request query resolver for '${providerId}' is already registered`);
  }
  syncRequestQueryResolvers.set(providerId, resolver);
}

export function defaultSyncRequestQuery(jobData: SyncJobData): SyncApiQuery {
  const window = syncWindowFromJobData(jobData);
  return {
    path: "sync",
    filters: {
      sinceIso: window.sinceIso,
      untilIso: window.untilIso,
    },
  };
}

export function resolveSyncRequestQuery(
  providerId: string,
  jobData: SyncJobData,
): SyncApiQuery | null {
  const resolver = syncRequestQueryResolvers.get(providerId);
  if (resolver) {
    return resolver(jobData);
  }
  return defaultSyncRequestQuery(jobData);
}

export function buildSyncRequestJobId(
  providerId: string,
  userId: string,
  query: SyncApiQuery,
): string {
  // SHA-256 truncated to 24 hex chars (96 bits) — collision risk is negligible
  // for job IDs scoped to a single provider+user.
  const digest = createHash("sha256").update(syncApiQueryKey(query)).digest("hex").slice(0, 24);
  return `sync-req-${providerId}-${userId}-${digest}`;
}

export function isSyncRequestQueryPending(
  query: SyncApiQuery | null,
  pendingKeys: ReadonlySet<string>,
): boolean {
  return query != null && pendingKeys.has(syncApiQueryKey(query));
}

export function planSyncStepIfRequestNotPending<T>(
  steps: T[],
  step: T,
  toQuery: (step: T) => SyncApiQuery | null,
  pendingKeys: ReadonlySet<string>,
): void {
  if (!isSyncRequestQueryPending(toQuery(step), pendingKeys)) {
    steps.push(step);
  }
}
