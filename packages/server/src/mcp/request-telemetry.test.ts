import { describe, expect, it } from "vitest";
import {
  mcpClientCorrelationId,
  mcpRequestTelemetry,
  mcpToolsListResponseTelemetry,
  mcpTransportErrorCategory,
} from "./request-telemetry.ts";

describe("mcpRequestTelemetry", () => {
  it("allows only known protocol methods and tool names without retaining request arguments", () => {
    const secret = "private food details must never reach logs";

    const telemetry = mcpRequestTelemetry(
      {
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "create_food_entry", arguments: { description: secret } },
      },
      "2025-06-18",
    );

    expect(telemetry).toEqual({
      mcp_method: "tools/call",
      protocol_version: "2025-06-18",
      tool_name: "create_food_entry",
    });
    expect(JSON.stringify(telemetry)).not.toContain(secret);
  });

  it("categorizes unrecognized client values rather than logging them", () => {
    const telemetry = mcpRequestTelemetry(
      { method: "private.method", params: { name: "person@example.com" } },
      "a client supplied header value",
    );

    expect(telemetry).toEqual({
      mcp_method: "unknown",
      protocol_version: "unknown",
    });
    expect(JSON.stringify(telemetry)).not.toContain("person@example.com");
  });

  it("categorizes transport errors without retaining their text", () => {
    const error = new Error("Unsupported Protocol Version: customer-provided-value");

    expect(mcpTransportErrorCategory(error)).toBe("unsupported_protocol_version");
    expect(JSON.stringify({ category: mcpTransportErrorCategory(error) })).not.toContain(
      "customer-provided-value",
    );
  });

  it("creates a stable opaque correlation key for a client", () => {
    const clientId = "https://client.example/metadata.json";
    const correlationId = mcpClientCorrelationId(clientId);

    expect(correlationId).toHaveLength(64);
    expect(correlationId).toBe(mcpClientCorrelationId(clientId));
    expect(correlationId).not.toContain(clientId);
  });
});

describe("mcpToolsListResponseTelemetry", () => {
  it("records a valid tools/list result without retaining definitions", () => {
    const privateDescription = "private health details";
    const telemetry = mcpToolsListResponseTelemetry({
      jsonrpc: "2.0",
      result: {
        nextCursor: "opaque-page-cursor",
        tools: [
          { name: "create_food_entry", description: privateDescription, inputSchema: {} },
          { name: "search_food_entries", description: privateDescription, inputSchema: {} },
        ],
      },
    });

    expect(telemetry).toMatchObject({
      jsonrpc_outcome: "result",
      tools_count: 2,
      expected_food_tools_present: true,
      has_next_page: true,
      tool_schema_valid: true,
    });
    expect(telemetry.tool_definition_fingerprint).toHaveLength(64);
    expect(JSON.stringify(telemetry)).not.toContain(privateDescription);
    expect(JSON.stringify(telemetry)).not.toContain("opaque-page-cursor");
  });

  it("identifies JSON-RPC errors separately from malformed results", () => {
    expect(mcpToolsListResponseTelemetry({ error: { code: -32603 } })).toEqual({
      jsonrpc_outcome: "error",
    });
    expect(mcpToolsListResponseTelemetry({ result: { tools: "not-an-array" } })).toEqual({
      jsonrpc_outcome: "invalid",
    });
  });
});
