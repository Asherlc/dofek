import { TRPCError } from "@trpc/server";
import {
  ActivityExportError,
  type ActivityExportFormat,
  type ActivityExportInput,
  serializeActivityExport,
} from "dofek/activity-export";
import type { Database } from "dofek/db";
import { getProvider } from "dofek/providers/registry";
import type { AccessWindow } from "../billing/entitlement.ts";
import type { ActivityDetail } from "../models/activity.ts";
import { Activity } from "../models/activity.ts";
import type { ActivitySensorStore } from "../repositories/activity-repository.ts";
import { ActivityRepository } from "../repositories/activity-repository.ts";
import { ensureProvidersRegistered } from "../routers/sync-helpers.ts";

/** Chart previews cap at 10k points; exports should include the full activity stream. */
const ACTIVITY_EXPORT_MAX_STREAM_POINTS = 1_000_000;

export async function loadActivityExportInput(
  db: Database,
  userId: string,
  timezone: string,
  accessWindow: AccessWindow,
  sensorStore: ActivitySensorStore | undefined,
  activityId: string,
): Promise<ActivityExportInput> {
  const repo = new ActivityRepository(db, userId, timezone, accessWindow, sensorStore);
  const row = await repo.findById(activityId);
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "Activity not found" });
  }

  await ensureProvidersRegistered();
  const detail: ActivityDetail = new Activity(row, getProvider).toDetail();

  let points: ActivityExportInput["points"] = [];
  if (sensorStore) {
    const stream = await repo.getStream(activityId, ACTIVITY_EXPORT_MAX_STREAM_POINTS);
    points = stream.map((point) => point.toDetail());
  }

  return {
    id: detail.id,
    activityType: detail.activityType,
    startedAt: detail.startedAt,
    endedAt: detail.endedAt,
    name: detail.name,
    notes: detail.notes,
    avgHr: detail.avgHr,
    maxHr: detail.maxHr,
    avgPower: detail.avgPower,
    maxPower: detail.maxPower,
    avgSpeed: detail.avgSpeed,
    maxSpeed: detail.maxSpeed,
    avgCadence: detail.avgCadence,
    totalDistance: detail.totalDistance,
    elevationGain: detail.elevationGain,
    elevationLoss: detail.elevationLoss,
    points,
  };
}

export async function exportActivityFile(
  db: Database,
  userId: string,
  timezone: string,
  accessWindow: AccessWindow,
  sensorStore: ActivitySensorStore | undefined,
  activityId: string,
  format: ActivityExportFormat,
) {
  const activity = await loadActivityExportInput(
    db,
    userId,
    timezone,
    accessWindow,
    sensorStore,
    activityId,
  );

  try {
    return serializeActivityExport(activity, format);
  } catch (error) {
    if (error instanceof ActivityExportError && error.code === "NO_GPS") {
      throw new TRPCError({ code: "BAD_REQUEST", message: error.message });
    }
    throw error;
  }
}

export { ActivityExportError };
