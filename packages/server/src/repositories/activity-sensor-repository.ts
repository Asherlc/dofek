import { mapHrZones, mapPowerZones } from "@dofek/zones/zones";
import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import type { ActivityMetricSourceSelection } from "../contracts/activity-metric-sources.ts";
import { BaseRepository } from "../lib/base-repository.ts";
import { activityOriginFromColumns } from "../models/activity-origin.ts";
import { ActivitySourceAttribution } from "../models/activity-source-attribution.ts";
import { buildActivitySourceTree } from "../models/activity-source-tree.ts";
import { listActivityHardware } from "./activity-hardware-repository.ts";
import { getActivityMetricSources } from "./activity-metric-sources-repository.ts";
import { activityDetailRowSchema, streamPointRowSchema } from "./activity-repository-schemas.ts";
import type {
  ActivitySensorReadStore,
  ActivitySensorWindow,
  StreamPointRow,
} from "./activity-sensor-types.ts";
import { getActivitySourceHrZones } from "./activity-source-hr-zones.ts";
import { ClimbingActivityLogEntryRepository } from "./climbing-activity-log-entry-repository.ts";

/** A single data point from an activity's metric stream. */
export class StreamPoint {
  readonly #row: StreamPointRow;

  constructor(row: StreamPointRow) {
    this.#row = row;
  }

  toDetail() {
    return {
      recordedAt: String(this.#row.recorded_at),
      heartRate: this.#row.heart_rate != null ? Number(this.#row.heart_rate) : null,
      power: this.#row.power != null ? Number(this.#row.power) : null,
      speed: this.#row.speed != null ? Number(this.#row.speed) : null,
      cadence: this.#row.cadence != null ? Number(this.#row.cadence) : null,
      altitude: this.#row.altitude != null ? Number(this.#row.altitude) : null,
      lat: this.#row.lat != null ? Number(this.#row.lat) : null,
      lng: this.#row.lng != null ? Number(this.#row.lng) : null,
      skinTemperature:
        this.#row.skin_temperature != null ? Number(this.#row.skin_temperature) : null,
      skinTemperatureRecordedAt: this.#row.skin_temperature_recorded_at
        ? String(this.#row.skin_temperature_recorded_at)
        : null,
    };
  }
}

function activityNotFoundError(): TRPCError {
  return new TRPCError({ code: "NOT_FOUND", message: "Activity not found" });
}

export class ActivitySensorRepository extends BaseRepository {
  async getStream(
    store: ActivitySensorReadStore,
    window: ActivitySensorWindow,
    maxPoints: number,
    sources?: ActivityMetricSourceSelection,
  ): Promise<StreamPoint[]> {
    const rows = await (sources && Object.keys(sources).length > 0
      ? store.getStream(window, maxPoints, sources)
      : store.getStream(window, maxPoints));
    return rows.map((row) => new StreamPoint(streamPointRowSchema.parse(row)));
  }

  async getHardware(window: ActivitySensorWindow) {
    return listActivityHardware(this.db, window);
  }

  async getMetricSources(
    store: ActivitySensorReadStore,
    window: ActivitySensorWindow,
    hardware: Awaited<ReturnType<typeof listActivityHardware>>,
    responseVersion: 1 | 2,
  ) {
    if (responseVersion === 1) return getActivityMetricSources(store, window, hardware);
    const [ancestry] = await this.query(
      activityDetailRowSchema.pick({
        primary_activity_id: true,
        primary_provider_id: true,
        primary_source_name: true,
        origin_candidate_member_ids: true,
        origin_evidence: true,
        source_external_ids: true,
        absent_source_external_ids: true,
      }),
      sql`SELECT primary_activity_id::text, primary_provider_id, primary_source_name,
        origin_candidate_member_ids::text[], origin_evidence,
        source_external_ids, absent_source_external_ids
      FROM fitness.v_activity WHERE id = ${window.activityId}::uuid AND user_id = ${this.userId}::uuid`,
    );
    if (!ancestry) throw activityNotFoundError();
    const sessions = await new ClimbingActivityLogEntryRepository(
      this.db,
      this.userId,
      this.timezone,
      this.accessWindow,
    ).getActivityLogSessions([window.activityId]);
    const sourceTree = buildActivitySourceTree(
      activityOriginFromColumns(ancestry),
      ActivitySourceAttribution.fromEntries(
        ancestry.source_external_ids,
        ancestry.absent_source_external_ids,
      ).toSourceLinks(() => undefined),
      ancestry.origin_evidence,
      sessions.get(window.activityId) ?? [],
    );
    return getActivityMetricSources(store, window, hardware, sourceTree);
  }

  async getHrZones(
    store: ActivitySensorReadStore,
    window: ActivitySensorWindow,
    heartRateSourceId?: string,
  ): Promise<import("@dofek/zones/zones").ActivityHrZone[]> {
    return heartRateSourceId
      ? getActivitySourceHrZones(store, window, heartRateSourceId)
      : mapHrZones(await store.getHeartRateZoneSeconds(window));
  }

  async getPowerZones(
    store: ActivitySensorReadStore,
    window: ActivitySensorWindow,
    ftp: number,
    powerSourceId?: string,
  ): Promise<import("@dofek/zones/zones").ActivityPowerZone[]> {
    return mapPowerZones(
      await (powerSourceId
        ? store.getPowerZoneSeconds(window, ftp, powerSourceId)
        : store.getPowerZoneSeconds(window, ftp)),
    );
  }
}
