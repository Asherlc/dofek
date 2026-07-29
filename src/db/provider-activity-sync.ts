import { resolveRecordLocalTimeContext } from "@dofek/format/record-local-time";
import type { ProviderActivityType } from "@dofek/training/activity-types";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { captureException } from "../lib/error-reporting.ts";
import type { SyncDatabase } from "./index.ts";
import {
  hasProviderActivityListSyncErrors,
  markProviderActivityAbsent,
  markProviderActivityPresent,
  type ProviderActivityAbsenceMark,
  type ProviderActivityAbsenceReconciliation,
  reconcileProviderActivityAbsence,
} from "./provider-activity-absence.ts";
import { activity } from "./schema/activity.ts";
import { executeWithSchema } from "./typed-sql.ts";

type StoredActivityInsert = typeof activity.$inferInsert;

export type ProviderActivityInsert = Omit<
  StoredActivityInsert,
  "canonicalType" | "providerType" | "modality"
> & {
  activityType: ProviderActivityType;
};

type StoredActivityConflictUpdateKey = Exclude<
  keyof StoredActivityInsert,
  "userId" | "providerId" | "externalId" | "providerAbsentAt"
>;

type StoredActivityConflictUpdate = {
  [K in StoredActivityConflictUpdateKey]?: StoredActivityInsert[K] | SQL;
};

/** Fields allowed in activity upsert conflict updates. Never includes providerAbsentAt. */
export type ProviderActivityConflictUpdate = Omit<
  StoredActivityConflictUpdate,
  "canonicalType" | "providerType" | "modality"
> & {
  activityType?: ProviderActivityType;
};

export interface ProviderActivityListSyncScope {
  db: SyncDatabase;
  providerId: string;
  windowStart: Date;
  windowEnd: Date;
  userId?: string;
}

export interface ProviderActivityExactIdentity {
  providerId: string;
  userId: string;
  canonicalType: StoredActivityInsert["canonicalType"];
  startedAt: Date;
  endedAt: Date;
}

const providerActivityIdSchema = z.object({ id: z.string().uuid() });

/** Return an active activity only when the exact provider identity uniquely identifies one row. */
export async function findUniqueProviderActivityByExactIdentity(
  db: SyncDatabase,
  identity: ProviderActivityExactIdentity,
): Promise<{ id: string } | undefined> {
  const rows = await executeWithSchema(
    db,
    providerActivityIdSchema,
    sql`SELECT id::text AS id
        FROM fitness.activity
        WHERE provider_id = ${identity.providerId}
          AND user_id = ${identity.userId}
          AND canonical_type = ${identity.canonicalType}
          AND started_at = ${identity.startedAt}
          AND ended_at = ${identity.endedAt}
          AND provider_absent_at IS NULL
          AND deleted_at IS NULL
        LIMIT 2`,
  );
  return rows.length === 1 ? rows[0] : undefined;
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
): { values: StoredActivityInsert; updateLocalTimeContext: boolean } {
  const { activityType, ...storedValues } = values;
  const externalIdValues: StoredActivityInsert = {
    ...storedValues,
    canonicalType: activityType.canonicalType,
    providerType: activityType.providerType,
    modality: activityType.modality,
    externalId: normalizedExternalId,
  };
  if ((externalIdValues.localTimeSource ?? "unknown") !== "unknown") {
    return { values: externalIdValues, updateLocalTimeContext: true };
  }

  const timezone = externalIdValues.timezone?.trim();
  if (!timezone) {
    const hasUntrustedContext =
      externalIdValues.timezone != null ||
      externalIdValues.startUtcOffsetMinutes != null ||
      externalIdValues.endUtcOffsetMinutes != null;
    return hasUntrustedContext
      ? {
          values: {
            ...externalIdValues,
            timezone: null,
            startUtcOffsetMinutes: null,
            endUtcOffsetMinutes: null,
            localTimeSource: "unknown",
          },
          updateLocalTimeContext: true,
        }
      : { values: externalIdValues, updateLocalTimeContext: false };
  }
  try {
    const context = resolveRecordLocalTimeContext({
      startedAt: externalIdValues.startedAt,
      endedAt: externalIdValues.endedAt,
      timezone,
      source: "provider_timezone",
    });
    return {
      values: {
        ...externalIdValues,
        timezone: context.timezone,
        startUtcOffsetMinutes: context.startUtcOffsetMinutes,
        endUtcOffsetMinutes: context.endUtcOffsetMinutes,
        localTimeSource: context.source,
      },
      updateLocalTimeContext: true,
    };
  } catch (error: unknown) {
    captureException(error, {
      tags: { operation: "provider-activity-local-time-context" },
    });
    return {
      values: {
        ...externalIdValues,
        timezone: null,
        startUtcOffsetMinutes: null,
        endUtcOffsetMinutes: null,
        localTimeSource: "unknown",
      },
      updateLocalTimeContext: true,
    };
  }
}

function normalizeProviderActivityConflictUpdate(
  update: ProviderActivityConflictUpdate,
): StoredActivityConflictUpdate {
  const { activityType, ...storedUpdate } = update;
  if (!activityType) return storedUpdate;
  return {
    ...storedUpdate,
    canonicalType: activityType.canonicalType,
    providerType: activityType.providerType,
    modality: activityType.modality,
  };
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
      { ...values, externalId: normalizedExternalId },
      update,
    );
    this.trackPresent(normalizedExternalId);
    return row;
  }

  async reconcile(
    presentExternalIds?: ReadonlySet<string>,
    options?: Pick<ProviderActivityAbsenceReconciliation, "presentAppleHealthIdentities">,
  ): Promise<void> {
    if (this.#reconciliationDisabled) return;
    await finishProviderActivityListSync(this.#scope.db, {
      providerId: this.#scope.providerId,
      userId: this.#scope.userId,
      windowStart: this.#scope.windowStart,
      windowEnd: this.#scope.windowEnd,
      presentExternalIds: presentExternalIds ?? this.#presentExternalIds,
      presentAppleHealthIdentities: options?.presentAppleHealthIdentities,
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
  const normalized = normalizeProviderActivityInsert(values, normalizedExternalId);
  const normalizedValues = normalized.values;
  const contextUpdate = normalized.updateLocalTimeContext
    ? {
        timezone: normalizedValues.timezone,
        startUtcOffsetMinutes: normalizedValues.startUtcOffsetMinutes,
        endUtcOffsetMinutes: normalizedValues.endUtcOffsetMinutes,
        localTimeSource: normalizedValues.localTimeSource,
      }
    : {};

  const [row] = await db
    .insert(activity)
    .values(normalizedValues)
    .onConflictDoUpdate({
      target: [activity.userId, activity.providerId, activity.externalId],
      set: { ...normalizeProviderActivityConflictUpdate(update), ...contextUpdate },
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
