import { type SQL, sql } from "drizzle-orm";
import { queryCache } from "../lib/cache.ts";
import {
  APPLE_HEALTH_PROVIDER_ID,
  type AppleHealthWorkoutIdentity,
} from "../providers/apple-health/workout-identity.ts";
import type { SyncDatabase } from "./index.ts";
import { getTokenUserId } from "./token-user-context.ts";

export interface ProviderActivityAbsenceReconciliation {
  providerId: string;
  windowStart: Date;
  windowEnd: Date;
  presentExternalIds: ReadonlySet<string>;
  /** Set only after a complete, validated source list proves that no activities remain. */
  emptyListIsAuthoritative?: boolean;
  /** When reconciling Apple Health, identities present in the current workout push. */
  presentAppleHealthIdentities?: readonly AppleHealthWorkoutIdentity[];
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

/** A stale downstream list cannot override a confirmed origin tombstone. */
const originAllowsRestoreSql = sql`NOT EXISTS (
    SELECT 1 FROM fitness.activity_copy_identity(candidate.provider_id, candidate.external_id, candidate.raw) AS copy
    LEFT JOIN fitness.activity AS origin ON origin.user_id = candidate.user_id
      AND origin.provider_id = copy.provider_id
      AND LOWER(REPLACE(origin.external_id, '-', '')) = copy.external_id
    WHERE origin.provider_absent_at IS NOT NULL OR origin.deleted_at IS NOT NULL
      OR COALESCE(candidate.absence_provider_id, candidate.provider_id) <> candidate.provider_id
  )`;

/** Only authoritative origin presence releases a propagated absence. */
async function confirmOriginPresence(
  db: SyncDatabase,
  userId: string,
  providerId: string,
  externalIds: readonly string[],
): Promise<void> {
  await db.execute(sql`
    UPDATE fitness.activity AS candidate
    SET absence_provider_id = candidate.provider_id
    WHERE candidate.user_id = ${userId}
      AND candidate.absence_provider_id = ${providerId}
      AND candidate.provider_id <> ${providerId}
      AND candidate.provider_absent_at IS NOT NULL AND candidate.deleted_at IS NULL
      AND EXISTS (
        SELECT 1 FROM fitness.activity_copy_identity(candidate.provider_id, candidate.external_id, candidate.raw) AS copy
        WHERE copy.provider_id = ${providerId}
          AND EXISTS (
            SELECT 1 FROM unnest(${sql.param(externalIds)}::text[]) AS present(external_id)
            WHERE copy.external_id = LOWER(REPLACE(present.external_id, '-', ''))
          )
      )
  `);
}

/** Skip tombstoning Apple Health rows superseded by another identity in the current push. */
export function appleHealthDuplicateTombstoneGuardSql(
  identities: readonly AppleHealthWorkoutIdentity[],
): SQL {
  if (identities.length === 0) {
    return sql``;
  }

  const matchConditions: SQL[] = [];

  const syncIdentifiers = [
    ...new Set(
      identities
        .map((identity) => identity.syncIdentifier)
        .filter((syncIdentifier): syncIdentifier is string => syncIdentifier != null),
    ),
  ];
  if (syncIdentifiers.length > 0) {
    matchConditions.push(sql`
      NULLIF(trim(raw->'metadata'->>'HKMetadataKeySyncIdentifier'), '') IN (${externalIdListSql(syncIdentifiers)})
    `);
  }

  for (const identity of identities) {
    if (identity.syncIdentifier) continue;
    matchConditions.push(sql`
      (
        NULLIF(trim(raw->'metadata'->>'HKMetadataKeySyncIdentifier'), '') IS NULL
        AND started_at = ${identity.startedAt}
        AND ended_at = ${identity.endedAt}
        AND COALESCE(raw->>'sourceName', source_name, '') = ${identity.sourceName}
      )
    `);
  }

  if (matchConditions.length === 0) {
    return sql``;
  }

  return sql`
    AND NOT (
      provider_id = ${APPLE_HEALTH_PROVIDER_ID}
      AND (${sql.join(matchConditions, sql` OR `)})
    )
  `;
}

/**
 * Tombstone activities missing from an authoritative provider list and restore
 * activities that reappear. Provider sync code should call this only through
 * `finishProviderActivityListSync()` / `ProviderActivityListSync` in
 * `provider-activity-sync.ts`. Activity upserts must not null the column on
 * conflict or a later sync phase can undo tombstones.
 */
export async function reconcileProviderActivityAbsence(
  db: SyncDatabase,
  reconciliation: ProviderActivityAbsenceReconciliation,
): Promise<void> {
  const userId = resolveUserId(reconciliation.userId);
  const presentExternalIds = presentExternalIdValues(reconciliation.presentExternalIds);

  if (presentExternalIds.length === 0 && !reconciliation.emptyListIsAuthoritative) {
    // An empty provider list is ambiguous: the user may have deleted everything in
    // the window, or HealthKit/API may have returned no rows transiently. Skip
    // tombstoning so we do not hide workouts that still exist upstream.
    await invalidateActivityVisibilityCaches(userId);
    return;
  }

  const appleHealthDuplicateGuard =
    reconciliation.providerId === APPLE_HEALTH_PROVIDER_ID
      ? appleHealthDuplicateTombstoneGuardSql(reconciliation.presentAppleHealthIdentities ?? [])
      : sql``;

  if (presentExternalIds.length > 0) {
    await db.execute(sql`
    UPDATE fitness.activity AS candidate
    SET provider_absent_at = NULL, absence_provider_id = NULL
    WHERE user_id = ${userId}
      AND provider_id = ${reconciliation.providerId}
      AND external_id IN (${externalIdListSql(presentExternalIds)})
      AND provider_absent_at IS NOT NULL
      AND deleted_at IS NULL
      AND ${originAllowsRestoreSql}
  `);
    await confirmOriginPresence(db, userId, reconciliation.providerId, presentExternalIds);
  }

  await db.execute(sql`
    WITH linked_copies AS (
      SELECT DISTINCT candidate.id, copy.provider_id AS absence_provider_id
      FROM fitness.activity AS candidate
      CROSS JOIN LATERAL fitness.activity_copy_identity(candidate.provider_id, candidate.external_id, candidate.raw) AS copy
      LEFT JOIN fitness.activity AS origin
        ON origin.user_id = candidate.user_id AND origin.provider_id = copy.provider_id
        AND LOWER(REPLACE(origin.external_id, '-', '')) = copy.external_id
      WHERE candidate.user_id = ${userId}
        AND candidate.deleted_at IS NULL
        AND (candidate.provider_absent_at IS NULL OR candidate.absence_provider_id IS DISTINCT FROM copy.provider_id)
        AND (
          origin.provider_absent_at IS NOT NULL OR origin.deleted_at IS NOT NULL
          OR (
            copy.provider_id = ${reconciliation.providerId}
            AND COALESCE(origin.started_at, candidate.started_at) >= ${reconciliation.windowStart}
            AND COALESCE(origin.started_at, candidate.started_at) < ${reconciliation.windowEnd}
            AND NOT EXISTS (
              SELECT 1 FROM unnest(${sql.param(presentExternalIds)}::text[]) AS present(external_id)
              WHERE copy.external_id = LOWER(REPLACE(present.external_id, '-', ''))
            )
          )
        )
    )
    UPDATE fitness.activity AS candidate
    SET provider_absent_at = COALESCE(candidate.provider_absent_at, NOW()),
      absence_provider_id = COALESCE(
        (SELECT absence_provider_id FROM linked_copies WHERE id = candidate.id),
        ${reconciliation.providerId}
      )
    WHERE user_id = ${userId}
      AND deleted_at IS NULL
      AND (
        (
          provider_id = ${reconciliation.providerId}
          AND provider_absent_at IS NULL
          AND external_id IS NOT NULL
          AND external_id <> ''
          AND started_at >= ${reconciliation.windowStart}
          AND started_at < ${reconciliation.windowEnd}
          ${presentExternalIds.length === 0 ? sql`` : sql`AND external_id NOT IN (${externalIdListSql(presentExternalIds)})`}
          ${appleHealthDuplicateGuard}
        )
        OR id IN (SELECT id FROM linked_copies)
      )
  `);

  await invalidateActivityVisibilityCaches(userId);
}

export async function markProviderActivityAbsent(
  db: SyncDatabase,
  mark: ProviderActivityAbsenceMark,
): Promise<number> {
  const userId = resolveUserId(mark.userId);
  const markedRows = await db.execute<{ id: string }>(sql`
    UPDATE fitness.activity AS candidate
    SET provider_absent_at = COALESCE(provider_absent_at, NOW()), absence_provider_id = ${mark.providerId}
    WHERE user_id = ${userId}
      AND (
        (provider_id = ${mark.providerId} AND external_id = ${mark.externalId} AND provider_absent_at IS NULL)
        OR EXISTS (
          SELECT 1 FROM fitness.activity_copy_identity(candidate.provider_id, candidate.external_id, candidate.raw) AS copy
          WHERE copy.provider_id = ${mark.providerId}
            AND copy.external_id = LOWER(REPLACE(${mark.externalId}, '-', ''))
        )
      )
      AND (provider_absent_at IS NULL OR COALESCE(absence_provider_id, provider_id) <> ${mark.providerId})
      AND deleted_at IS NULL
    RETURNING id
  `);

  await invalidateActivityVisibilityCaches(userId);
  return markedRows.length;
}

export async function markProviderActivityPresent(
  db: SyncDatabase,
  mark: ProviderActivityAbsenceMark,
): Promise<void> {
  const userId = resolveUserId(mark.userId);
  await db.execute(sql`
    UPDATE fitness.activity AS candidate
    SET provider_absent_at = NULL, absence_provider_id = NULL
    WHERE user_id = ${userId}
      AND provider_id = ${mark.providerId}
      AND external_id = ${mark.externalId}
      AND provider_absent_at IS NOT NULL
      AND deleted_at IS NULL
      AND ${originAllowsRestoreSql}
  `);

  await confirmOriginPresence(db, userId, mark.providerId, [mark.externalId]);

  await invalidateActivityVisibilityCaches(userId);
}
