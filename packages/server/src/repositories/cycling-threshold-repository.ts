import type {
  CyclingThresholdEvidence,
  CyclingThresholdHistoryItem,
} from "../contracts/cycling-threshold.ts";
import { cyclingThresholdUncertainty } from "../contracts/cycling-threshold.ts";

export type {
  CyclingThresholdEvidence,
  CyclingThresholdHistoryItem,
} from "../contracts/cycling-threshold.ts";

import { createHash } from "node:crypto";
import { z } from "zod";
import {
  type AccessWindow,
  clickHouseAccessParams,
  clickHouseAccessPredicate,
} from "../billing/entitlement.ts";
import { timestampStringSchema } from "../lib/typed-sql.ts";
import type { ActivitySensorStore } from "./activity-repository.ts";

const evidenceColumns = {
  evidence_activity_id: z.string().uuid().nullable(),
  evidence_at: z.string().nullable(),
  evidence_duration_seconds: z.coerce.number().positive().nullable(),
  evidence_power: z.coerce.number().nonnegative().nullable(),
};
const historyRowSchema = z.object({
  event_at: z.string(),
  activity_id: z.string().uuid().nullable(),
  eftp: z.coerce.number().positive().nullable(),
  ...evidenceColumns,
  model_version: z.string(),
});
const activityMetricsSchema = z.object({
  model_version: z.string(),
  activity_id: z.string().uuid(),
  started_at: timestampStringSchema,
  normalized_power: z.coerce.number().nonnegative().nullable(),
  eftp: z.coerce.number().positive().nullable(),
  power_tss: z.coerce.number().nonnegative().nullable(),
  intensity_factor: z.coerce.number().nonnegative().nullable(),
  ...evidenceColumns,
});
export type CyclingActivityPowerMetrics = z.infer<typeof activityMetricsSchema>;
export interface CyclingThresholdHistoryInput {
  startDate: string;
  endDate: string;
  cursor: string | null;
  limit: number;
}
export interface CyclingThresholdHistoryPage {
  start_date: string;
  end_date: string;
  items: CyclingThresholdHistoryItem[];
  next_cursor: string | null;
}
const cursorSchema = z
  .object({
    version: z.literal(2),
    userId: z.uuid(),
    shape: z.string(),
    eventAt: z.string(),
    activityId: z.string(),
  })
  .strict();
const unavailableReason =
  "No qualifying cycling power evidence is available on or before this date. Record a supported sustained cycling power effort.";
function evidence(row: z.infer<typeof historyRowSchema> | undefined): CyclingThresholdEvidence {
  return {
    value: row?.eftp ?? null,
    uncertainty: cyclingThresholdUncertainty,
    unit: "watt",
    method: "computed_eftp",
    event_at: row?.event_at ?? null,
    evidence_activity_id: row?.evidence_activity_id ?? null,
    evidence_at: row?.evidence_at ?? null,
    evidence_duration_seconds: row?.evidence_duration_seconds ?? null,
    evidence_power: row?.evidence_power ?? null,
    model_version: row?.model_version ?? null,
    unavailable_reason: row?.eftp == null ? unavailableReason : null,
  };
}
/** Maps an already computed activity metric row to its applicable threshold evidence. */
export function cyclingThresholdEvidenceFromMetrics(
  metrics: CyclingActivityPowerMetrics | null,
): CyclingThresholdEvidence {
  return evidence(metrics ? { ...metrics, event_at: metrics.started_at } : undefined);
}

function selectedEvidence(alias: string): string {
  return `if(${alias}.evidence_activity_id IS NULL, NULL, toString(${alias}.evidence_activity_id)) AS evidence_activity_id,
    if(${alias}.evidence_at IS NULL, NULL, formatDateTime(${alias}.evidence_at, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC')) AS evidence_at,
    ${alias}.evidence_duration_seconds AS evidence_duration_seconds, ${alias}.evidence_power AS evidence_power`;
}
const selectedHistory = `formatDateTime(history.event_at, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS event_at,
  if(history.activity_id IS NULL, NULL, toString(history.activity_id)) AS activity_id,
  history.eftp AS eftp, ${selectedEvidence("history")}, history.model_version AS model_version`;

/** Reads the one computed cycling threshold history; never estimates on requests. */
export class CyclingThresholdRepository {
  readonly #store: Pick<ActivitySensorStore, "query">;
  readonly #userId: string;
  readonly #timezone: string;
  readonly #accessWindow: AccessWindow | undefined;
  constructor(
    store: Pick<ActivitySensorStore, "query">,
    userId: string,
    timezone: string,
    accessWindow?: AccessWindow,
  ) {
    this.#store = store;
    this.#userId = userId;
    this.#timezone = timezone;
    this.#accessWindow = accessWindow;
  }
  async getCurrent(): Promise<CyclingThresholdEvidence> {
    const rows = await this.#store.query(
      historyRowSchema,
      `SELECT ${selectedHistory}
      FROM analytics.cycling_threshold_history AS history
      WHERE history.user_id = {userId:UUID} AND history.event_at <= now64(6)
      ${clickHouseAccessPredicate(this.#accessWindow, "history.event_at")}
      ORDER BY history.event_at DESC, ifNull(toString(history.activity_id), '') DESC LIMIT 1`,
      { userId: this.#userId, ...clickHouseAccessParams(this.#accessWindow) },
    );
    return evidence(rows[0]);
  }
  async getAsOf(timestamp: string): Promise<CyclingThresholdEvidence> {
    const rows = await this.#store.query(
      historyRowSchema,
      `SELECT ${selectedHistory}
      FROM analytics.cycling_threshold_history AS history
      WHERE history.user_id = {userId:UUID}
        ${clickHouseAccessPredicate(this.#accessWindow, "history.event_at")}
        ${
          /^\d{4}-\d{2}-\d{2}$/.test(timestamp)
            ? "AND history.event_at < toDateTime64(addDays(toDate({asOf:String}), 1), 6, {timezone:String})"
            : "AND history.event_at <= parseDateTime64BestEffort({asOf:String}, 6)"
        }
      ORDER BY history.event_at DESC, ifNull(toString(history.activity_id), '') DESC LIMIT 1`,
      {
        userId: this.#userId,
        asOf: timestamp,
        timezone: this.#timezone,
        ...clickHouseAccessParams(this.#accessWindow),
      },
    );
    return evidence(rows[0]);
  }
  async getForActivities(activityIds: string[]): Promise<Map<string, CyclingActivityPowerMetrics>> {
    if (activityIds.length === 0) return new Map();
    const rows = await this.#store.query(
      activityMetricsSchema,
      `SELECT
      toString(metrics.activity_id) AS activity_id,
      formatDateTime(metrics.started_at, '%Y-%m-%dT%H:%i:%S.%fZ', 'UTC') AS started_at,
      normalized_power, eftp, power_tss, intensity_factor, metrics.model_version AS model_version, ${selectedEvidence("metrics")}
      FROM analytics.cycling_activity_power_metrics AS metrics
      WHERE metrics.user_id = {userId:UUID} AND metrics.activity_id IN ({activityIds:Array(UUID)})
      ${clickHouseAccessPredicate(this.#accessWindow, "metrics.started_at")}`,
      { userId: this.#userId, activityIds, ...clickHouseAccessParams(this.#accessWindow) },
    );
    return new Map(rows.map((row) => [row.activity_id, row]));
  }
  async listHistory(input: CyclingThresholdHistoryInput): Promise<CyclingThresholdHistoryPage> {
    const shape = createHash("sha256")
      .update(
        JSON.stringify({
          startDate: input.startDate,
          endDate: input.endDate,
          timezone: this.#timezone,
        }),
      )
      .digest("hex");
    const cursor = input.cursor ? this.#decodeCursor(input.cursor, shape) : null;
    const rows = await this.#store.query(
      historyRowSchema,
      `SELECT ${selectedHistory}
      FROM analytics.cycling_threshold_history AS history
      WHERE history.user_id = {userId:UUID}
        ${clickHouseAccessPredicate(this.#accessWindow, "history.event_at")}
        AND toDate(toTimeZone(history.event_at, {timezone:String})) BETWEEN toDate({startDate:String}) AND toDate({endDate:String})
        ${
          cursor
            ? `AND (history.event_at < parseDateTime64BestEffort({cursorAt:String}, 6)
          OR (history.event_at = parseDateTime64BestEffort({cursorAt:String}, 6)
            AND ifNull(toString(history.activity_id), '') < {cursorActivityId:String}))`
            : ""
        }
      ORDER BY history.event_at DESC, ifNull(toString(history.activity_id), '') DESC
      LIMIT {pageLimit:UInt32}`,
      {
        userId: this.#userId,
        timezone: this.#timezone,
        startDate: input.startDate,
        endDate: input.endDate,
        pageLimit: input.limit + 1,
        ...clickHouseAccessParams(this.#accessWindow),
        ...(cursor ? { cursorAt: cursor.eventAt, cursorActivityId: cursor.activityId } : {}),
      },
    );
    const page = rows.slice(0, input.limit);
    const last = page.at(-1);
    return {
      start_date: input.startDate,
      end_date: input.endDate,
      items: page.map((row) => ({
        ...evidence(row),
        activity_id: row.activity_id,
        evidence_kind: "computed",
        historical_validity: "effective_dated",
      })),
      next_cursor:
        rows.length > input.limit && last
          ? Buffer.from(
              JSON.stringify({
                version: 2,
                userId: this.#userId,
                shape,
                eventAt: last.event_at,
                activityId: last.activity_id ?? "",
              }),
            ).toString("base64url")
          : null,
    };
  }
  #decodeCursor(value: string, shape: string): z.infer<typeof cursorSchema> {
    let cursor: z.infer<typeof cursorSchema>;
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid encoding");
      const decoded = Buffer.from(value, "base64url").toString("utf8");
      if (
        Buffer.byteLength(decoded, "utf8") > 2048 ||
        Buffer.from(decoded).toString("base64url") !== value
      )
        throw new Error("invalid encoding");
      cursor = cursorSchema.parse(JSON.parse(decoded));
    } catch {
      throw new Error("Invalid analytical cursor");
    }
    if (cursor.userId !== this.#userId || cursor.shape !== shape)
      throw new Error("Cursor does not match this request");
    return cursor;
  }
}
