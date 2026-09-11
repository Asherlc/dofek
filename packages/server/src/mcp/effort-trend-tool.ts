import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { dateSchema } from "../lib/date-schema.ts";
import { EffortTrendRepository } from "../repositories/effort-trend-repository.ts";
import { PerformanceComparisonRepository } from "../repositories/performance-comparison-repository.ts";
import { RepeatedEffortsRepository } from "../repositories/repeated-efforts-repository.ts";
import type { DofekMcpContext } from "./context.ts";
import { effortTrendOutputSchema } from "./effort-trend-output.ts";
import {
  performanceComparisonEquivalenceInputSchema,
  toRepositoryEquivalence,
} from "./performance-comparison-tool.ts";
import { requireMcpScope } from "./token-repository.ts";
import { jsonToolResult } from "./tool-result.ts";
import { assertDateRange } from "./tool-utils.ts";

/** Register descriptive trends over a provider-neutral repeated-effort identity. */
export function registerEffortTrendTool(server: McpServer, context: DofekMcpContext): void {
  server.registerTool(
    "get_effort_trend",
    {
      title: "Get Effort Trend",
      description:
        "Return chronological repetitions and descriptive deltas for one discovered effort ID or explicit provider-neutral equivalence. Reuses identity-aware performance comparison metrics, quality, and evidence. Level A exact: namespaced recorded identity. Level B strong_inferred: measured route geometry or other strong identity inference. Level C caller_asserted: explicit names or user-defined benchmark membership. Level D weak_similarity: discovery name/type/modality/duration groups or activity_name with asserted=false; these are not comparable efforts. False-fitness guard: ordinary workout bests are lower-bound observed capability, not maximal capacity; lower observed values do not demonstrate fitness decline. Identity alone does not establish maximal intent or comparable conditions.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: {
        start_date: dateSchema,
        end_date: dateSchema,
        effort_id: z.string().min(1).max(16384).optional(),
        equivalence: performanceComparisonEquivalenceInputSchema.optional(),
      },
      outputSchema: effortTrendOutputSchema,
    },
    async ({ start_date, end_date, effort_id, equivalence }) => {
      requireMcpScope(context.scopes, "activity:read");
      assertDateRange(start_date, end_date);
      if (Boolean(effort_id) === Boolean(equivalence)) {
        throw new Error("get_effort_trend requires exactly one effort_id or equivalence");
      }
      if (!context.sensorStore) {
        throw new Error("get_effort_trend requires the ClickHouse analytics store");
      }
      const comparison = new PerformanceComparisonRepository(
        context.db,
        context.sensorStore,
        context.userId,
        context.timezone,
      );
      const discovery = new RepeatedEffortsRepository(
        context.db,
        context.sensorStore,
        context.userId,
        context.timezone,
      );
      return jsonToolResult(
        await new EffortTrendRepository(comparison, discovery).get({
          effortId: effort_id,
          equivalence: equivalence ? toRepositoryEquivalence(equivalence) : undefined,
          startDate: start_date,
          endDate: end_date,
        }),
      );
    },
  );
}
