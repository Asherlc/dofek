import { sql } from "drizzle-orm";
import { queryCache } from "../lib/cache.ts";
import type { SyncDatabase } from "./index.ts";
import { getTokenUserId } from "./token-user-context.ts";

export interface ProviderActivityAbsenceReconciliation {
  providerId: string;
  windowStart: Date;
  windowEnd: Date;
  presentExternalIds: ReadonlySet<string>;
  userId?: string;
}

export interface ProviderActivityAbsenceMark {
  providerId: string;
  externalId: string;
  userId?: string;
}

export function hasProviderActivityListSyncErrors(
  errors: ReadonlyArray<{ message: string }>,
  activityListErrorPrefixes: readonly string[],
): boolean {
  return errors.some((error) =>
    activityListErrorPrefixes.some((prefix) => error.message.startsWith(prefix)),
  );
}

function resolveUserId(userId?: string): string {
  const scopedUserId = userId ?? getTokenUserId();
  if (!scopedUserId) {
    throw new Error("Provider activity absence reconciliation requires userId");
  }
  return scopedUserId;
}

export async function invalidateActivityVisibilityCaches(userId: string): Promise<void> {
  await Promise.all([
    queryCache.invalidateByPrefix(`${userId}:activity.`),
    queryCache.invalidateByPrefix(`${userId}:calendar.`),
    queryCache.invalidateByPrefix(`${userId}:training.`),
    queryCache.invalidateByPrefix(`${userId}:running.`),
  ]);
}

function presentExternalIdValues(presentExternalIds: ReadonlySet<string>): string[] {
  return [...presentExternalIds].filter((externalId) => externalId.trim() !== "");
}

function externalIdListSql(externalIds: string[]) {
  return sql.join(
    externalIds.map((externalId) => sql`${externalId}`),
    sql`, `,
  );
}

export async function reconcileProviderActivityAbsence(
  db: SyncDatabase,
  reconciliation: ProviderActivityAbsenceReconciliation,
): Promise<void> {
  const userId = resolveUserId(reconciliation.userId);
  const presentExternalIds = presentExternalIdValues(reconciliation.presentExternalIds);

  if (presentExternalIds.length > 0) {
    await db.execute(sql`
      UPDATE fitness.activity
      SET provider_absent_at = NULL
      WHERE user_id = ${userId}
        AND provider_id = ${reconciliation.providerId}
        AND external_id IN (${externalIdListSql(presentExternalIds)})
        AND provider_absent_at IS NOT NULL
        AND deleted_at IS NULL
    `);
  }

  const missingExternalIdPredicate =
    presentExternalIds.length > 0
      ? sql`AND external_id NOT IN (${externalIdListSql(presentExternalIds)})`
      : sql``;

  await db.execute(sql`
    UPDATE fitness.activity
    SET provider_absent_at = NOW()
    WHERE user_id = ${userId}
      AND provider_id = ${reconciliation.providerId}
      AND provider_absent_at IS NULL
      AND deleted_at IS NULL
      AND external_id IS NOT NULL
      AND external_id <> ''
      AND started_at >= ${reconciliation.windowStart}
      AND started_at < ${reconciliation.windowEnd}
    ${missingExternalIdPredicate}
  `);

  await invalidateActivityVisibilityCaches(userId);
}

export async function markProviderActivityAbsent(
  db: SyncDatabase,
  mark: ProviderActivityAbsenceMark,
): Promise<void> {
  const userId = resolveUserId(mark.userId);
  await db.execute(sql`
    UPDATE fitness.activity
    SET provider_absent_at = NOW()
    WHERE user_id = ${userId}
      AND provider_id = ${mark.providerId}
      AND external_id = ${mark.externalId}
      AND provider_absent_at IS NULL
      AND deleted_at IS NULL
  `);

  await invalidateActivityVisibilityCaches(userId);
}
