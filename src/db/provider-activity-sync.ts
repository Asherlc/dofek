import {
  resolveProviderTimezoneLocalTimeContext,
  resolveRecordLocalTimeContext,
} from "@dofek/format/record-local-time";
import type { ProviderActivityType } from "@dofek/training/activity-types";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { captureException } from "../lib/error-reporting.ts";
import { logger } from "../logger.ts";
import type { SyncDatabase } from "./index.ts";
import {
  hasProviderActivityListSyncErrors,
  markProviderActivityAbsent,
  markProviderActivityPresent,
  type ProviderActivityAbsenceMark,
  type ProviderActivityAbsenceReconciliation,
  reconcileProviderActivityAbsence,
} from "./provider-activity-absence.ts";
import { getProviderIngestContext } from "./provider-ingest-context.ts";
import { activity } from "./schema/activity.ts";
import { executeWithSchema } from "./typed-sql.ts";

type StoredActivityInsert = typeof activity.$inferInsert;

export type ProviderActivityInsert = Omit<
  StoredActivityInsert,
  "canonicalType" | "providerType" | "modality"
> & {
  activityType: ProviderActivityType;
  /** User-selected geographic zone, used only when a provider emits an untrustworthy fixed zone. */
  homeTimezone?: string | null;
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
  providerType: StoredActivityInsert["providerType"];
  modality: StoredActivityInsert["modality"];
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
          AND provider_type = ${identity.providerType}
          AND modality IS NOT DISTINCT FROM ${identity.modality}
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

function providerTimezoneContext(values: StoredActivityInsert, timezone: string) {
  return resolveProviderTimezoneLocalTimeContext({
    startedAt: values.startedAt,
    endedAt: values.endedAt,
    timezone,
  });
}

function normalizeProviderActivityInsert(
  values: ProviderActivityInsert,
  normalizedExternalId: string,
): { values: StoredActivityInsert; updateLocalTimeContext: boolean } {
  const { activityType, homeTimezone: explicitHomeTimezone, ...storedValues } = values;
  const externalIdValues: StoredActivityInsert = {
    ...storedValues,
    canonicalType: activityType.canonicalType,
    providerType: activityType.providerType,
    modality: activityType.modality,
    externalId: normalizedExternalId,
  };
  const normalizedHomeTimezone = explicitHomeTimezone ?? getProviderIngestContext()?.homeTimezone;
  if ((externalIdValues.localTimeSource ?? "unknown") !== "unknown") {
    const timezone = externalIdValues.timezone?.trim();
    if (externalIdValues.localTimeSource === "provider_timezone" && timezone) {
      try {
        const providerContext = providerTimezoneContext(externalIdValues, timezone);
        if (normalizedHomeTimezone) {
          try {
            const homeContext = resolveRecordLocalTimeContext({
              startedAt: externalIdValues.startedAt,
              endedAt: externalIdValues.endedAt,
              timezone: normalizedHomeTimezone,
              source: "user_home_timezone",
            });
            if (
              providerContext.startUtcOffsetMinutes != null &&
              homeContext.startUtcOffsetMinutes != null &&
              Math.abs(providerContext.startUtcOffsetMinutes - homeContext.startUtcOffsetMinutes) >
                60
            ) {
              logger.warn(
                `[provider-activity] timezone disagreement provider=${externalIdValues.providerId} external_id=${normalizedExternalId} provider_timezone=${timezone} home_timezone=${normalizedHomeTimezone}`,
              );
            }
          } catch (error: unknown) {
            captureException(error, {
              tags: { operation: "provider-activity-home-timezone-context" },
            });
          }
        }
        return {
          values: {
            ...externalIdValues,
            timezone: providerContext.timezone,
            startUtcOffsetMinutes: providerContext.startUtcOffsetMinutes,
            endUtcOffsetMinutes: providerContext.endUtcOffsetMinutes,
            localTimeSource: providerContext.source,
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
    if (normalizedHomeTimezone) {
      try {
        const homeContext = resolveRecordLocalTimeContext({
          startedAt: externalIdValues.startedAt,
          endedAt: externalIdValues.endedAt,
          timezone: normalizedHomeTimezone,
          source: "user_home_timezone",
        });
        if (
          externalIdValues.startUtcOffsetMinutes != null &&
          homeContext.startUtcOffsetMinutes != null &&
          Math.abs(externalIdValues.startUtcOffsetMinutes - homeContext.startUtcOffsetMinutes) > 60
        ) {
          logger.warn(
            `[provider-activity] timezone disagreement provider=${externalIdValues.providerId} external_id=${normalizedExternalId} provider_timezone=${timezone ?? "offset-only"} home_timezone=${normalizedHomeTimezone}`,
          );
        }
      } catch (error: unknown) {
        captureException(error, {
          tags: { operation: "provider-activity-home-timezone-context" },
        });
      }
    }
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
    if (normalizedHomeTimezone) {
      const providerContext = providerTimezoneContext(externalIdValues, timezone);
      const homeContext = resolveRecordLocalTimeContext({
        startedAt: externalIdValues.startedAt,
        endedAt: externalIdValues.endedAt,
        timezone: normalizedHomeTimezone,
        source: "user_home_timezone",
      });
      if (
        providerContext.startUtcOffsetMinutes != null &&
        homeContext.startUtcOffsetMinutes != null &&
        Math.abs(providerContext.startUtcOffsetMinutes - homeContext.startUtcOffsetMinutes) > 60
      ) {
        logger.warn(
          `[provider-activity] timezone disagreement provider=${externalIdValues.providerId} external_id=${normalizedExternalId} provider_timezone=${timezone} home_timezone=${normalizedHomeTimezone}`,
        );
      }
      return {
        values: {
          ...externalIdValues,
          timezone: providerContext.timezone,
          startUtcOffsetMinutes: providerContext.startUtcOffsetMinutes,
          endUtcOffsetMinutes: providerContext.endUtcOffsetMinutes,
          localTimeSource: providerContext.source,
        },
        updateLocalTimeContext: true,
      };
    }
    const context = providerTimezoneContext(externalIdValues, timezone);
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
    db: SyncDatabase = this.#scope.db,
  ): Promise<{ id: string } | undefined> {
    const normalizedExternalId = requireExternalId(values.externalId);
    const row = await upsertProviderActivity(
      db,
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

export type { ProviderActivityAbsenceMark, ProviderActivityAbsenceReconciliation };
export {
  hasProviderActivityListSyncErrors,
  markProviderActivityAbsent,
  markProviderActivityPresent,
};
