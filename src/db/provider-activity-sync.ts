import type { SQL } from "drizzle-orm";
import type { SyncDatabase } from "./index.ts";
import {
  hasProviderActivityListSyncErrors,
  markProviderActivityAbsent,
  markProviderActivityPresent,
  type ProviderActivityAbsenceMark,
  type ProviderActivityAbsenceReconciliation,
  reconcileProviderActivityAbsence,
} from "./provider-activity-absence.ts";
import { activity } from "./schema.ts";

export type ProviderActivityInsert = typeof activity.$inferInsert;

type ProviderActivityConflictUpdateKey = Exclude<
  keyof ProviderActivityInsert,
  "userId" | "providerId" | "externalId" | "providerAbsentAt"
>;

/** Fields allowed in activity upsert conflict updates. Never includes providerAbsentAt. */
export type ProviderActivityConflictUpdate = {
  [K in ProviderActivityConflictUpdateKey]?: ProviderActivityInsert[K] | SQL;
};

export interface ProviderActivityListSyncScope {
  db: SyncDatabase;
  providerId: string;
  windowStart: Date;
  windowEnd: Date;
  userId?: string;
}

function requireExternalId(externalId: string | null | undefined): string {
  const normalizedExternalId = externalId?.trim();
  if (!normalizedExternalId) {
    throw new Error("Provider activity upsert requires externalId");
  }
  return normalizedExternalId;
}

function normalizeProviderActivityInsert(
  values: ProviderActivityInsert,
  normalizedExternalId: string,
): ProviderActivityInsert {
  return values.externalId === normalizedExternalId
    ? values
    : { ...values, externalId: normalizedExternalId };
}

/**
 * Tracks activities present in an authoritative provider list fetch and
 * tombstones rows missing from that list when `reconcile()` runs.
 */
export class ProviderActivityListSync {
  readonly #scope: ProviderActivityListSyncScope;
  readonly #presentExternalIds = new Set<string>();
  #reconciliationDisabled = false;

  constructor(scope: ProviderActivityListSyncScope) {
    this.#scope = scope;
  }

  disableReconciliation(): void {
    this.#reconciliationDisabled = true;
  }

  trackPresent(externalId: string | null | undefined): void {
    if (externalId == null) return;
    const trimmed = externalId.trim();
    if (trimmed !== "") {
      this.#presentExternalIds.add(trimmed);
    }
  }

  get presentExternalIds(): ReadonlySet<string> {
    return this.#presentExternalIds;
  }

  replacePresentExternalIds(externalIds: Iterable<string>): void {
    this.#presentExternalIds.clear();
    for (const externalId of externalIds) {
      this.trackPresent(externalId);
    }
  }

  async upsert(
    values: ProviderActivityInsert,
    update: ProviderActivityConflictUpdate,
  ): Promise<{ id: string } | undefined> {
    const normalizedExternalId = requireExternalId(values.externalId);
    const row = await upsertProviderActivity(
      this.#scope.db,
      normalizeProviderActivityInsert(values, normalizedExternalId),
      update,
    );
    this.trackPresent(normalizedExternalId);
    return row;
  }

  async reconcile(presentExternalIds?: ReadonlySet<string>): Promise<void> {
    if (this.#reconciliationDisabled) return;
    await finishProviderActivityListSync(this.#scope.db, {
      providerId: this.#scope.providerId,
      userId: this.#scope.userId,
      windowStart: this.#scope.windowStart,
      windowEnd: this.#scope.windowEnd,
      presentExternalIds: presentExternalIds ?? this.#presentExternalIds,
    });
  }
}

/** Upsert a provider activity without clearing an existing provider tombstone. */
export async function upsertProviderActivity(
  db: SyncDatabase,
  values: ProviderActivityInsert,
  update: ProviderActivityConflictUpdate,
): Promise<{ id: string } | undefined> {
  const normalizedExternalId = requireExternalId(values.externalId);

  const [row] = await db
    .insert(activity)
    .values(normalizeProviderActivityInsert(values, normalizedExternalId))
    .onConflictDoUpdate({
      target: [activity.userId, activity.providerId, activity.externalId],
      set: update,
    })
    .returning({ id: activity.id });

  return row;
}

/** Tombstone provider activities missing from a completed authoritative list fetch. */
export async function finishProviderActivityListSync(
  db: SyncDatabase,
  reconciliation: ProviderActivityAbsenceReconciliation,
): Promise<void> {
  await reconcileProviderActivityAbsence(db, reconciliation);
}

export {
  hasProviderActivityListSyncErrors,
  markProviderActivityAbsent,
  markProviderActivityPresent,
};
export type { ProviderActivityAbsenceMark, ProviderActivityAbsenceReconciliation };
