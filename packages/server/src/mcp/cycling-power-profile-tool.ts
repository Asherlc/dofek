import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getAccessWindowForUser } from "../billing/access-window-repository.ts";
import { cyclingPowerProfileSchema } from "../contracts/cycling-power-profile.ts";
import { dateSchema } from "../lib/date-schema.ts";
import { CyclingPowerProfileRepository } from "../repositories/cycling-power-profile-repository.ts";
import { registerAuthorizedTool } from "./authorized-tool.ts";
import type { DofekMcpContext } from "./context.ts";
import { requireMcpScope } from "./token-repository.ts";
import { jsonToolResult } from "./tool-result.ts";
import { assertDateRange } from "./tool-utils.ts";

export function registerCyclingPowerProfileTool(server: McpServer, context: DofekMcpContext): void {
  registerAuthorizedTool(
    server,
    ["activity:read", "health:read"],
    "get_cycling_power_profile",
    {
      title: "Get Cycling Power Profile",
      description:
        "Return demonstrated 5-second, 1-minute, and 5-minute cycling power and configured FTP as of the range end, in watts and W/kg when nearby body weight is available. Includes source evidence and body-weight records, so it requires health:read. Recorded efforts leave maximal test status unverified.",
      annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
      inputSchema: z.object({ start_date: dateSchema, end_date: dateSchema }),
      outputSchema: z.object({ result: cyclingPowerProfileSchema }),
    },
    async ({ start_date, end_date }) => {
      requireMcpScope(context.scopes, "activity:read");
      requireMcpScope(context.scopes, "health:read");
      assertDateRange(start_date, end_date);
      if (!context.sensorStore) {
        throw new Error("get_cycling_power_profile requires the ClickHouse analytics store");
      }
      const profile = await new CyclingPowerProfileRepository(
        context.db,
        context.sensorStore,
        context.userId,
        context.timezone,
        await getAccessWindowForUser(context.db, context.userId, context.timezone),
      ).read({ startDate: start_date, endDate: end_date });
      return jsonToolResult(profile);
    },
  );
}
