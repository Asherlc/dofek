import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ActivityRepository } from "../repositories/activity-repository.ts";
import type { DofekMcpContext } from "./context.ts";
import { requireMcpScope } from "./token-repository.ts";
import { jsonContent } from "./tool-utils.ts";

const activityStreamChannelSchema = z.enum([
  "power",
  "heart_rate",
  "cadence",
  "altitude",
  "speed",
  "position",
]);

/** Register capped access to deduped activity sensor streams. */
export function registerActivityStreamsTool(server: McpServer, context: DofekMcpContext): void {
  server.registerTool(
    "get_activity_streams",
    {
      title: "Get Activity Streams",
      description:
        "Return a capped, downsampled activity time series. Select only the channels needed for analysis.",
      annotations: { readOnlyHint: true },
      inputSchema: {
        activity_id: z.uuid(),
        channels: z.array(activityStreamChannelSchema).min(1).optional(),
        downsample_to: z.number().int().min(1).max(2000).optional(),
      },
    },
    async ({ activity_id, channels, downsample_to }) => {
      requireMcpScope(context.scopes, "activity:read");
      if (!context.sensorStore) {
        throw new Error("get_activity_streams requires the ClickHouse analytics store");
      }
      const selectedChannels = channels ?? activityStreamChannelSchema.options;
      const rows = await new ActivityRepository(
        context.db,
        context.userId,
        context.timezone,
        { kind: "full", paid: true, reason: "paid_grant" },
        context.sensorStore,
      ).getStream(activity_id, downsample_to ?? 500);
      return jsonContent({
        channels: selectedChannels,
        points: rows.map((streamPoint) => {
          const point = streamPoint.toDetail();
          return {
            recorded_at: point.recordedAt,
            ...(selectedChannels.includes("power") ? { power: point.power } : {}),
            ...(selectedChannels.includes("heart_rate") ? { heart_rate: point.heartRate } : {}),
            ...(selectedChannels.includes("cadence") ? { cadence: point.cadence } : {}),
            ...(selectedChannels.includes("altitude") ? { altitude: point.altitude } : {}),
            ...(selectedChannels.includes("speed") ? { speed: point.speed } : {}),
            ...(selectedChannels.includes("position")
              ? { latitude: point.lat, longitude: point.lng }
              : {}),
          };
        }),
      });
    },
  );
}
