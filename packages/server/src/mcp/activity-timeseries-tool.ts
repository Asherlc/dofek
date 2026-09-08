import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ActivityRepository } from "../repositories/activity-repository.ts";
import { activityTimeseriesStreams } from "../repositories/activity-timeseries.ts";
import { ActivityTimeseriesRepository } from "../repositories/activity-timeseries-repository.ts";
import type { DofekMcpContext } from "./context.ts";
import { requireMcpScope } from "./token-repository.ts";
import { activityTimeseriesOutputSchema } from "./tool-output.ts";
import { jsonToolResult } from "./tool-result.ts";

const resolutionSchema = z.enum(["raw", "1s", "5s", "10s", "30s", "60s"]);
const fillSchema = z.enum(["none", "linear"]);
const streamSchema = z.enum(activityTimeseriesStreams);

/** Register synchronized, provenance-rich access to native activity sensor samples. */
export function registerActivityTimeseriesTool(server: McpServer, context: DofekMcpContext): void {
  server.registerTool(
    "get_activity_timeseries",
    {
      title: "Get Activity Time Series",
      description:
        "Return synchronized, provenance-rich activity streams with explicit measured, zero, interpolated, and missing states. Raw detail is available; compact fixed resolutions are recommended for broad analysis.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: {
        activity_id: z.uuid(),
        streams: z.array(streamSchema).min(1),
        resolution: resolutionSchema.optional(),
        fill: fillSchema.optional(),
        cursor: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(2_000).optional(),
      },
      outputSchema: activityTimeseriesOutputSchema,
    },
    async ({ activity_id, streams, resolution, fill, cursor, limit }) => {
      requireMcpScope(context.scopes, "activity:read");
      if (!context.sensorStore) {
        throw new Error("get_activity_timeseries requires the ClickHouse analytics store");
      }
      const page = await new ActivityTimeseriesRepository(
        new ActivityRepository(context.db, context.userId, context.timezone),
        context.sensorStore,
      ).list({
        activityId: activity_id,
        streams,
        resolution: resolution ?? "raw",
        fill: fill ?? "none",
        cursor: cursor ?? null,
        limit: limit ?? 500,
      });
      return jsonToolResult({
        activity: {
          id: page.activity.id,
          started_at: page.activity.startedAt,
          ended_at: page.activity.endedAt,
          source_providers: page.activity.sourceProviders,
          member_activity_ids: page.activity.memberActivityIds,
          local_time_context: page.activity.localTimeContext,
        },
        resolution: {
          requested: page.resolution.requested,
          effective_seconds: page.resolution.effectiveSeconds,
        },
        offsets_seconds: page.offsetsSeconds,
        timestamps: page.timestamps,
        streams: Object.fromEntries(
          Object.entries(page.streams).map(([stream, column]) => [
            stream,
            {
              values: column.values,
              states: column.states,
              source_indexes: column.sourceIndexes,
              unit: column.unit,
              summary: {
                min: column.summary.min,
                max: column.summary.max,
                average: column.summary.average,
                observed_samples: column.summary.observedSamples,
                missing_points: column.summary.missingPoints,
                zero_points: column.summary.zeroPoints,
                largest_gap_seconds: column.summary.largestGapSeconds,
              },
              availability_reason: column.availabilityReason,
            },
          ]),
        ),
        sources: page.sources,
        next_cursor: page.nextCursor,
      });
    },
  );
}
