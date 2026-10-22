import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { createActivityTypeMapper, GARMIN_ACTIVITY_TYPE_MAP } from "@dofek/training/training";
import { and, eq } from "drizzle-orm";
import type { SyncDatabase } from "../../db/index.ts";
import { upsertProviderActivity } from "../../db/provider-activity-sync.ts";
import { activity } from "../../db/schema/activity.ts";
import { importFitFile } from "../../jobs/process-fit-file-import-job.ts";
import type { ProviderArtifactStorage } from "../../provider-artifact-storage.ts";
import type { SyncOptions } from "../types.ts";
import {
  garminActivityFileSchema,
  garminActivitySchema,
  garminManualActivitySchema,
} from "./payloads.ts";

interface ActivityDependencies {
  artifacts: ProviderArtifactStorage;
  fetchFn: typeof globalThis.fetch;
  accessToken: string;
}

const mapActivityType = createActivityTypeMapper(GARMIN_ACTIVITY_TYPE_MAP);

async function resolveActivityMetadata(
  db: SyncDatabase,
  userId: string,
  externalId: string,
  record: Record<string, unknown> & {
    activityName?: string;
    deviceName?: string;
    manual?: boolean;
  },
): Promise<{
  name: string | undefined;
  sourceName: string | undefined;
  raw: Record<string, unknown>;
}> {
  const [stored] = await db
    .select({ name: activity.name, sourceName: activity.sourceName, raw: activity.raw })
    .from(activity)
    .where(
      and(
        eq(activity.userId, userId),
        eq(activity.providerId, "garmin"),
        eq(activity.externalId, externalId),
      ),
    )
    .limit(1);
  const storedManual =
    stored?.raw && typeof stored.raw === "object" && "manual" in stored.raw
      ? stored.raw.manual
      : undefined;
  const manual = record.manual ?? (typeof storedManual === "boolean" ? storedManual : undefined);
  // Garmin identifies manually created activities with the placeholder "unknown".
  const deviceName =
    record.deviceName === "unknown" || record.deviceName === "" ? undefined : record.deviceName;
  return {
    name: record.activityName ?? stored?.name ?? undefined,
    sourceName: deviceName ?? stored?.sourceName ?? undefined,
    raw: manual === undefined ? record : { ...record, manual },
  };
}

export async function syncGarminActivityRecord(
  db: SyncDatabase,
  type: "activities" | "manuallyUpdatedActivities" | "activityFiles",
  payload: unknown,
  options: SyncOptions,
  dependencies: ActivityDependencies,
): Promise<number> {
  const userId = options.userId?.trim();
  if (!userId) throw new Error("Garmin activity persistence requires userId");

  if (type === "activityFiles") {
    const record = garminActivityFileSchema.parse(payload);
    if (record.fileType !== "FIT") {
      throw new Error(`Garmin activity file must be FIT; received ${record.fileType}`);
    }
    const externalId = String(record.activityId);
    const activityType = {
      ...mapActivityType(record.activityType.toUpperCase()),
      providerType: record.activityType,
    };
    const artifactId = createHash("sha256").update(record.callbackURL).digest("hex");
    const objectKey = await dependencies.artifacts.ensureArtifact({
      userId,
      providerId: "garmin",
      artifactId,
      download: async () => {
        const response = await dependencies.fetchFn(record.callbackURL, {
          headers: { Authorization: `Bearer ${dependencies.accessToken}` },
          redirect: "error",
          signal: options.signal,
        });
        if (!response.ok) {
          throw new Error(`Garmin activity file download failed (HTTP ${response.status})`);
        }
        if (!response.body) throw new Error("Garmin activity file download returned no body");
        return Readable.from(response.body);
      },
    });
    const directory = await mkdtemp(join(tmpdir(), "dofek-garmin-activity-"));
    const filePath = join(directory, "activity.fit");
    try {
      await dependencies.artifacts.materializeArtifact(objectKey, filePath);
      const metadata = await resolveActivityMetadata(db, userId, externalId, record);
      const result = await importFitFile(
        db,
        {
          filePath,
          originalPath: objectKey,
          userId,
          providerId: "garmin",
          sourceName: metadata.sourceName,
          activitySummary: {
            externalId,
            activityType,
            startedAtIso: new Date(record.startTimeInSeconds * 1000).toISOString(),
            name: metadata.name ?? "Garmin activity",
            raw: metadata.raw,
          },
        },
        async (progress) => options.onProgress?.(progress.percentage, progress.message),
        options.metricStreamPublisher,
      );
      if (result.errors.length > 0) {
        throw new Error(
          `Garmin FIT activity ${externalId}: ${result.errors.map((error) => error.message).join("; ")}`,
        );
      }
      return 1;
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }

  const record =
    type === "activities"
      ? garminActivitySchema.parse(payload)
      : garminManualActivitySchema.parse(payload);
  const externalId = record.activityId === undefined ? record.summaryId : String(record.activityId);
  const activityType = {
    ...mapActivityType(record.activityType.toUpperCase()),
    providerType: record.activityType,
  };
  const startedAt = new Date(record.startTimeInSeconds * 1000);
  const endedAt = new Date((record.startTimeInSeconds + record.durationInSeconds) * 1000);
  const metadata = await resolveActivityMetadata(db, userId, externalId, record);
  const fields = { activityType, startedAt, endedAt, ...metadata };
  await upsertProviderActivity(
    db,
    {
      userId,
      providerId: "garmin",
      externalId,
      ...fields,
      ...(record.startTimeOffsetInSeconds !== undefined
        ? {
            startUtcOffsetMinutes: record.startTimeOffsetInSeconds / 60,
            localTimeSource: "provider_offset",
          }
        : {}),
    },
    fields,
  );
  return 1;
}
