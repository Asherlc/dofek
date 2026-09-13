import { createHash } from "node:crypto";
import { logger } from "../logger.ts";

const foodMutationToolNames = new Set([
  "create_food_entry",
  "update_food_entry",
  "delete_food_entry",
  "restore_food_entry",
]);

export interface FoodMutationTelemetry {
  requestIdHash: string | null;
  toolName: string;
}

export type FoodMutationPhase = "started" | "succeeded" | "rejected" | "completed" | "aborted";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function foodMutationTelemetryForTool(
  toolName: string,
  requestId: string,
): FoodMutationTelemetry {
  return {
    toolName,
    requestIdHash: createHash("sha256").update(requestId).digest("hex"),
  };
}

export function foodMutationTelemetryFromRequest(body: unknown): FoodMutationTelemetry | null {
  if (!isRecord(body) || body.method !== "tools/call" || !isRecord(body.params)) return null;
  const toolName = body.params.name;
  if (typeof toolName !== "string" || !foodMutationToolNames.has(toolName)) return null;
  const requestId = isRecord(body.params.arguments) ? body.params.arguments.request_id : null;
  return {
    toolName,
    requestIdHash:
      typeof requestId === "string" ? createHash("sha256").update(requestId).digest("hex") : null,
  };
}

export function logFoodMutation(
  telemetry: FoodMutationTelemetry,
  phase: FoodMutationPhase,
  options: { errorCode?: string; httpStatus?: number } = {},
): void {
  logger.info("mcp.mutation", {
    tool_name: telemetry.toolName,
    request_id_hash: telemetry.requestIdHash,
    phase,
    ...(options.errorCode === undefined ? {} : { error_code: options.errorCode }),
    ...(options.httpStatus === undefined ? {} : { http_status: options.httpStatus }),
  });
}
