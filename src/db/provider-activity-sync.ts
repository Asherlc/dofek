import {
  localTimeSourceSchema,
  resolveProviderTimezoneLocalTimeContext,
  resolveRecordLocalTimeContext,
} from "@dofek/format/record-local-time";
import type { ProviderActivityType } from "@dofek/training/activity-types";
import { type SQL, sql } from "drizzle-orm";
import { z } from "zod";
import { captureException } from "../lib/error-reporting.ts";
import { logger } from "../logger.ts";
import {
  type PlausibleActivityLocalTimeResult,
  resolvePlausibleActivityLocalTime,
  type SuppliedActivityLocalTime,
} from "./activity-local-time.ts";
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
  | "canonicalType"
  | "providerType"
  | "modality"
  | "rejectedProviderTimezone"
  | "rejectedProviderStartUtcOffsetMinutes"
  | "rejectedProviderEndUtcOffsetMinutes"
> & {
  activityType: ProviderActivityType;
  /** User-selected geographic zone, used only when a provider emits an untrustworthy fixed zone. */
  homeTimezone?: string | null;
  /** Optional geographic evidence used ahead of the configured home zone. */
  localTimeCoordinates?: { latitude: number; longitude: number } | null;
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
): {
  values: StoredActivityInsert;
  updateLocalTimeContext: boolean;
  rejected: SuppliedActivityLocalTime | null;
} {
  const {
    activityType,
    homeTimezone: explicitHomeTimezone,
    localTimeCoordinates,
    ...storedValues
  } = values;
  const externalIdValues: StoredActivityInsert = {
    ...storedValues,
    canonicalType: activityType.canonicalType,
    providerType: activityType.providerType,
    modality: activityType.modality,
    externalId: normalizedExternalId,
  };
  const normalizedHomeTimezone = explicitHomeTimezone ?? getProviderIngestContext()?.homeTimezone;
  const rawSource = localTimeSourceSchema.safeParse(externalIdValues.localTimeSource ?? "unknown");
  const source = rawSource.success ? rawSource.data : "unknown";
  const timezone = externalIdValues.timezone?.trim() || null;
  const originalSupplied: SuppliedActivityLocalTime = {
    timezone,
    startUtcOffsetMinutes: externalIdValues.startUtcOffsetMinutes ?? null,
    endUtcOffsetMinutes: externalIdValues.endUtcOffsetMinutes ?? null,
    source: timezone && source === "unknown" ? "provider_timezone" : source,
  };
  const hasSuppliedContext =
    timezone != null ||
    externalIdValues.startUtcOffsetMinutes != null ||
    externalIdValues.endUtcOffsetMinutes != null ||
    source !== "unknown";
  if (!hasSuppliedContext && !normalizedHomeTimezone && !localTimeCoordinates) {
    return { values: externalIdValues, updateLocalTimeContext: false, rejected: null };
  }
  let supplied: SuppliedActivityLocalTime;
  try {
    if (timezone && (source === "provider_timezone" || source === "unknown")) {
      supplied = providerTimezoneContext(externalIdValues, timezone);
    } else if (timezone && (source === "device_timezone" || source === "user_home_timezone")) {
      supplied = resolveRecordLocalTimeContext({
        startedAt: externalIdValues.startedAt,
        endedAt: externalIdValues.endedAt,
        timezone,
        source,
      });
    } else if (source === "provider_offset" || source === "device_offset") {
      supplied = resolveRecordLocalTimeContext({
        startedAt: externalIdValues.startedAt,
        endedAt: externalIdValues.endedAt,
        startUtcOffsetMinutes: externalIdValues.startUtcOffsetMinutes,
        endUtcOffsetMinutes: externalIdValues.endUtcOffsetMinutes,
        source,
      });
    } else {
      supplied = {
        timezone: null,
        startUtcOffsetMinutes: null,
        endUtcOffsetMinutes: null,
        source: "unknown",
      };
    }
  } catch (error: unknown) {
    captureException(error, {
      tags: { operation: "provider-activity-local-time-context" },
    });
    supplied = {
      timezone,
      startUtcOffsetMinutes: externalIdValues.startUtcOffsetMinutes ?? null,
      endUtcOffsetMinutes: externalIdValues.endUtcOffsetMinutes ?? null,
      source: timezone && source === "unknown" ? "provider_timezone" : source,
    };
  }

  let resolution: PlausibleActivityLocalTimeResult;
  try {
    resolution = resolvePlausibleActivityLocalTime({
      startedAt: externalIdValues.startedAt,
      endedAt: externalIdValues.endedAt,
      supplied,
      homeTimezone: normalizedHomeTimezone,
      coordinates: localTimeCoordinates,
    });
  } catch (error: unknown) {
    captureException(error, {
      tags: { operation: "provider-activity-home-timezone-context" },
    });
    resolution = {
      context: {
        timezone: null,
        startUtcOffsetMinutes: null,
        endUtcOffsetMinutes: null,
        source: "unknown" as const,
      },
      rejected: supplied.source === "unknown" ? null : supplied,
      reference: null,
    };
  }

  return {
    values: {
      ...externalIdValues,
      timezone: resolution.context.timezone,
      startUtcOffsetMinutes: resolution.context.startUtcOffsetMinutes,
      endUtcOffsetMinutes: resolution.context.endUtcOffsetMinutes,
      localTimeSource: resolution.context.source,
      rejectedProviderTimezone: resolution.rejected ? originalSupplied.timezone : null,
      rejectedProviderStartUtcOffsetMinutes: resolution.rejected?.startUtcOffsetMinutes ?? null,
      rejectedProviderEndUtcOffsetMinutes: resolution.rejected?.endUtcOffsetMinutes ?? null,
    },
    updateLocalTimeContext: true,
    rejected: resolution.rejected
      ? { ...resolution.rejected, timezone: originalSupplied.timezone }
      : null,
  };
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
        rejectedProviderTimezone: normalizedValues.rejectedProviderTimezone,
        rejectedProviderStartUtcOffsetMinutes:
          normalizedValues.rejectedProviderStartUtcOffsetMinutes,
        rejectedProviderEndUtcOffsetMinutes: normalizedValues.rejectedProviderEndUtcOffsetMinutes,
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

  if (row && normalized.rejected) {
    logger.warn("activity local-time context rejected", {
      event: "activity_local_time_context_rejected",
      provider_id: normalizedValues.providerId,
      activity_id: row.id,
      supplied: normalized.rejected,
      substituted: {
        timezone: normalizedValues.timezone ?? null,
        startUtcOffsetMinutes: normalizedValues.startUtcOffsetMinutes ?? null,
        endUtcOffsetMinutes: normalizedValues.endUtcOffsetMinutes ?? null,
        source: normalizedValues.localTimeSource ?? "unknown",
      },
    });
  }

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
