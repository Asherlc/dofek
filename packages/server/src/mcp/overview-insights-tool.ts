import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { dateSchema } from "../lib/date-schema.ts";
import { InsightsRepository } from "../repositories/insights-repository.ts";
import { analysisTimezoneSchema } from "../repositories/sleep-episode-analysis.ts";
import { registerAuthorizedTool } from "./authorized-tool.ts";
import type { DofekMcpContext } from "./context.ts";
import {
  OVERVIEW_INSIGHTS_DAYS,
  overviewInsightsOutputSchema,
  toOverviewInsightsOutput,
} from "./overview-insights-output.ts";
import { requireMcpScope } from "./token-repository.ts";
import { jsonToolResult } from "./tool-result.ts";

/** Register the read-only Overview insights tool. */
export function registerOverviewInsightsTool(server: McpServer, context: DofekMcpContext): void {
  registerAuthorizedTool(
    server,
    ["health:read", "activity:read", "nutrition:read"],
    "get_overview_insights",
    {
      title: "Get Overview Insights",
      description:
        "Return the Overview's 90-day association and correlation candidates for the authenticated user, preserving candidate order and confidence (including insufficient candidates) with effect size, p-value, and evidence. Associations are descriptive and do not establish causation.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: z.object({
        end_date: dateSchema,
        timezone: analysisTimezoneSchema.optional(),
      }),
      outputSchema: overviewInsightsOutputSchema,
    },
    async ({ end_date, timezone }) => {
      requireMcpScope(context.scopes, "health:read");
      requireMcpScope(context.scopes, "activity:read");
      requireMcpScope(context.scopes, "nutrition:read");
      if (!context.sensorStore) {
        throw new Error("get_overview_insights requires the ClickHouse analytics store");
      }
      const requestedTimezone = timezone ?? context.timezone;
      const insights = await new InsightsRepository(
        context.db,
        context.userId,
        requestedTimezone,
        context.sensorStore,
      ).computeInsights(OVERVIEW_INSIGHTS_DAYS, end_date);
      return jsonToolResult(
        toOverviewInsightsOutput({ endDate: end_date, timezone: requestedTimezone, insights }),
      );
    },
  );
}
