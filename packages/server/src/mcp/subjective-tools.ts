import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { withAccountErasureUserWriteFence } from "dofek/db/account-erasure";
import { invalidateUserQueryDomains } from "dofek/lib/cache";
import { captureException } from "dofek/lib/error-reporting";
import { z } from "zod";
import { dateSchema } from "../lib/date-schema.ts";
import { injuryKindSchema, SubjectiveRepository } from "../repositories/subjective-repository.ts";
import type { DofekMcpContext } from "./context.ts";
import { requireMcpScope } from "./token-repository.ts";
import { mcpOutputSchemas } from "./tool-output.ts";
import { jsonToolResult } from "./tool-result.ts";
import { assertDateRange } from "./tool-utils.ts";

export function registerSubjectiveTools(server: McpServer, context: DofekMcpContext): void {
  server.registerTool(
    "list_body_regions",
    {
      title: "List Body Regions",
      description:
        "List the canonical body-region IDs and labels accepted by injury and niggle logging.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: {},
      outputSchema: mcpOutputSchemas.bodyRegions,
    },
    async () => {
      requireMcpScope(context.scopes, "health:read");
      const repository = new SubjectiveRepository(context.db, context.userId, context.timezone);
      return jsonToolResult(await repository.regions());
    },
  );

  server.registerTool(
    "get_subjective_timeline",
    {
      title: "Get Subjective Timeline",
      description: "Return raw subjective check-ins, symptoms, and injury events for a date range.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: {
        start_date: dateSchema,
        end_date: dateSchema,
      },
      outputSchema: mcpOutputSchemas.subjectiveTimeline,
    },
    async ({ start_date, end_date }) => {
      requireMcpScope(context.scopes, "health:read");
      assertDateRange(start_date, end_date);
      const repository = new SubjectiveRepository(context.db, context.userId, context.timezone);
      return jsonToolResult(await repository.timeline(start_date, end_date));
    },
  );

  server.registerTool(
    "log_injury",
    {
      title: "Log Injury",
      description:
        "Log a private injury or niggle against a canonical body-region ID. Use list_body_regions to discover valid IDs.",
      annotations: { readOnlyHint: false, openWorldHint: false, destructiveHint: false },
      inputSchema: {
        kind: injuryKindSchema,
        body_region_id: z.string().trim().min(1),
        onset_date: dateSchema,
        resolved_date: dateSchema.nullable().optional(),
        severity: z.number().int().min(0).max(10).nullable().optional(),
        description: z.string().trim().min(1),
      },
      outputSchema: mcpOutputSchemas.injuryEvent,
    },
    async ({ kind, body_region_id, onset_date, resolved_date, severity, description }) => {
      requireMcpScope(context.scopes, "health:write");
      if (resolved_date != null && resolved_date < onset_date) {
        throw new Error("resolved_date must be on or after onset_date");
      }
      const injury = await withAccountErasureUserWriteFence(
        context.db,
        context.userId,
        async (transaction) => {
          const repository = new SubjectiveRepository(
            transaction,
            context.userId,
            context.timezone,
          );
          const regions = await repository.regions();
          if (!regions.some((region) => region.id === body_region_id)) {
            throw new Error(
              `Unknown body_region_id: ${body_region_id}. Use list_body_regions to choose a valid ID.`,
            );
          }
          return repository.createInjury({
            kind,
            bodyRegionId: body_region_id,
            onsetDate: onset_date,
            resolvedDate: resolved_date ?? null,
            severity: severity ?? null,
            description,
          });
        },
      );
      try {
        await invalidateUserQueryDomains(context.userId, ["subjective"]);
      } catch (error) {
        captureException(error, {
          tags: { mcp_tool: "log_injury", operation: "cache_invalidation" },
        });
      }
      return jsonToolResult(injury);
    },
  );
}
