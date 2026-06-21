import type { SQL } from "drizzle-orm";
import type { SyncDatabase } from "./index.ts";
import { activity } from "./schema.ts";
import {
  hasProviderActivityListSyncErrors,
  markProviderActivityAbsent,
  reconcileProviderActivityAbsence,
  type ProviderActivityAbsenceMark,
  type ProviderActivityAbsenceReconciliation,
} from "./provider-activity-absence.ts";

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
    if (!values.externalId) {
      throw new Error("Provider activity upsert requires externalId");
    }
    this.trackPresent(values.externalId);
    return upsertProviderActivity(this.#scope.db, values, update);
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
  if (!values.externalId) {
    throw new Error("Provider activity upsert requires externalId");
  }

  const [row] = await db
    .insert(activity)
    .values(values)
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

export { hasProviderActivityListSyncErrors, markProviderActivityAbsent };
export type { ProviderActivityAbsenceMark, ProviderActivityAbsenceReconciliation };
