import { createHash, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

const protocolVersions = new Set(SUPPORTED_PROTOCOL_VERSIONS);
const maxClientCorrelationIds = 1_024;

const mcpMethods = new Set(["initialize", "notifications/initialized", "tools/list", "tools/call"]);

const mcpToolNames = new Set([
  "compare_performances",
  "create_food_entry",
  "delete_food_entry",
  "estimate_cycling_threshold",
  "find_repeated_efforts",
  "get_activity_details",
  "get_activity_streams",
  "get_activity_summary",
  "get_activity_timeseries",
  "get_body_metrics",
  "get_climbing_progression",
  "get_climbing_sessions",
  "get_cycling_performance",
  "get_cycling_power_curve",
  "get_cycling_training_metrics",
  "get_daily_health_summary",
  "get_data_coverage",
  "get_effort_trend",
  "get_finger_loading",
  "get_finger_loading_progression",
  "get_food_entry",
  "get_food_entry_history",
  "get_health_trends",
  "get_nutrition_summary",
  "get_recovery_training_series",
  "get_sleep_summary",
  "get_strength_progression",
  "get_strength_sessions",
  "get_subjective_timeline",
  "get_supplements",
  "get_threshold_history",
  "get_training_load",
  "list_body_regions",
  "list_providers",
  "log_injury",
  "render_health_explorer",
  "restore_food_entry",
  "search_activities",
  "search_food_entries",
  "start_provider_sync",
  "update_food_entry",
]);

const expectedFoodTools = new Set(["search_food_entries", "create_food_entry"]);
const clientCorrelationIds = new Map<string, string>();

const mcpRequestSchema = z
  .object({
    method: z.string().optional(),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

const mcpToolsListResponseSchema = z
  .object({
    error: z.record(z.string(), z.unknown()).optional(),
    result: z
      .object({
        nextCursor: z.string().optional(),
        tools: z.array(z.unknown()),
      })
      .loose()
      .optional(),
  })
  .loose();

const mcpToolSchema = z
  .object({
    inputSchema: z.record(z.string(), z.unknown()),
    name: z.string(),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
  })
  .loose();

type McpMethod =
  | "initialize"
  | "notifications/initialized"
  | "tools/list"
  | "tools/call"
  | "unknown";

export interface McpRequestTelemetry {
  mcp_method: McpMethod;
  protocol_version: string;
  tool_name?: string;
}

export interface McpToolsListResponseTelemetry {
  jsonrpc_outcome: "result" | "error" | "invalid";
  tools_count?: number;
  expected_food_tools_present?: boolean;
  has_next_page?: boolean;
  tool_definition_fingerprint?: string;
  tool_schema_valid?: boolean;
}

/** Creates a replica-lifetime diagnostic correlation key without retaining client identifiers. */
export function mcpClientCorrelationId(clientId: string): string {
  let correlationId = clientCorrelationIds.get(clientId);
  if (!correlationId) {
    if (clientCorrelationIds.size >= maxClientCorrelationIds) {
      const oldestClientId = clientCorrelationIds.keys().next().value;
      if (typeof oldestClientId === "string") clientCorrelationIds.delete(oldestClientId);
    }
    correlationId = randomUUID();
    clientCorrelationIds.set(clientId, correlationId);
  }
  return correlationId;
}

/** Deployment metadata is bounded to the image's build SHA and container hostname. */
export function mcpRuntimeTelemetry(): { build_revision: string; replica_id: string } {
  const revision = process.env.SENTRY_RELEASE;
  return {
    build_revision: revision && /^[a-f0-9]{7,64}$/i.test(revision) ? revision : "unknown",
    replica_id: hostname(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Summarizes a tools/list JSON-RPC response without retaining tool descriptions or schemas. */
export function mcpToolsListResponseTelemetry(message: unknown): McpToolsListResponseTelemetry {
  const parsed = mcpToolsListResponseSchema.safeParse(message);
  if (!parsed.success) return { jsonrpc_outcome: "invalid" };
  if (parsed.data.error) return { jsonrpc_outcome: "error" };
  if (!parsed.data.result) return { jsonrpc_outcome: "invalid" };

  const { tools } = parsed.data.result;
  const parsedTools = tools.map((tool) => mcpToolSchema.safeParse(tool));
  const toolNames = parsedTools.flatMap((tool) => (tool.success ? [tool.data.name] : []));
  const toolSchemaValid = parsedTools.every((tool) => tool.success);
  const fingerprint = createHash("sha256")
    .update(canonicalJson(parsedTools.map((tool) => (tool.success ? tool.data : null))))
    .digest("hex");

  return {
    jsonrpc_outcome: "result",
    tools_count: tools.length,
    expected_food_tools_present: [...expectedFoodTools].every((name) => toolNames.includes(name)),
    has_next_page: typeof parsed.data.result.nextCursor === "string",
    tool_definition_fingerprint: fingerprint,
    tool_schema_valid: toolSchemaValid,
  };
}

function isMcpMethod(value: unknown): value is McpMethod {
  return typeof value === "string" && mcpMethods.has(value);
}

/** Produces bounded MCP request labels without retaining untrusted payload content. */
export function mcpRequestTelemetry(
  body: unknown,
  protocolVersion: string | undefined,
): McpRequestTelemetry {
  const parsed = mcpRequestSchema.safeParse(body);
  const request = parsed.success ? parsed.data : undefined;
  const method = request && isMcpMethod(request.method) ? request.method : "unknown";
  const requestedProtocolVersion =
    method === "initialize" && typeof request?.params?.protocolVersion === "string"
      ? request.params.protocolVersion
      : protocolVersion;
  const telemetry: McpRequestTelemetry = {
    mcp_method: method,
    protocol_version:
      requestedProtocolVersion && protocolVersions.has(requestedProtocolVersion)
        ? requestedProtocolVersion
        : "unknown",
  };
  const toolName = request?.params?.name;
  if (method === "tools/call" && typeof toolName === "string" && mcpToolNames.has(toolName)) {
    telemetry.tool_name = toolName;
  }
  return telemetry;
}

/** Maps SDK error text to bounded diagnostics without retaining client-supplied values. */
export function mcpTransportErrorCategory(
  error: unknown,
):
  | "invalid_json"
  | "invalid_jsonrpc"
  | "unsupported_media_type"
  | "unsupported_protocol_version"
  | "transport_error" {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("Parse error: Invalid JSON-RPC")) return "invalid_jsonrpc";
  if (message.startsWith("Parse error: Invalid JSON")) return "invalid_json";
  if (message.startsWith("Unsupported Media Type")) return "unsupported_media_type";
  if (/^(?:Bad Request: )?Unsupported protocol version/i.test(message))
    return "unsupported_protocol_version";
  return "transport_error";
}
