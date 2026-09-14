import { describe, expect, it } from "vitest";
import {
  mcpClientCorrelationId,
  mcpRequestTelemetry,
  mcpRuntimeTelemetry,
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
    const error = new Error("Bad Request: Unsupported protocol version: customer-provided-value");

    expect(mcpTransportErrorCategory(error)).toBe("unsupported_protocol_version");
    expect(JSON.stringify({ category: mcpTransportErrorCategory(error) })).not.toContain(
      "customer-provided-value",
    );
  });

  it("separates every recognized transport rejection category", () => {
    expect(mcpTransportErrorCategory(new Error("Parse error: Invalid JSON-RPC payload"))).toBe(
      "invalid_jsonrpc",
    );
    expect(mcpTransportErrorCategory(new Error("Parse error: Invalid JSON payload"))).toBe(
      "invalid_json",
    );
    expect(mcpTransportErrorCategory(new Error("Unsupported Media Type: text/plain"))).toBe(
      "unsupported_media_type",
    );
    expect(mcpTransportErrorCategory(new Error("unrecognized"))).toBe("transport_error");
  });

  it("creates a stable opaque correlation key for a client", () => {
    const clientId = "https://client.example/metadata.json";
    const correlationId = mcpClientCorrelationId(clientId);

    expect(correlationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(correlationId).toBe(mcpClientCorrelationId(clientId));
    expect(correlationId).not.toContain(clientId);
    expect(mcpClientCorrelationId("another-client")).not.toBe(correlationId);
  });

  it("evicts the oldest client correlation after the bounded limit", () => {
    const firstCorrelation = mcpClientCorrelationId("bounded-client-0");
    for (let index = 1; index <= 1_024; index += 1) {
      mcpClientCorrelationId(`bounded-client-${index}`);
    }

    expect(mcpClientCorrelationId("bounded-client-0")).not.toBe(firstCorrelation);
  });

  it("reports only validated build revisions", () => {
    const original = process.env.SENTRY_RELEASE;
    try {
      process.env.SENTRY_RELEASE = "1a2b3c4";
      expect(mcpRuntimeTelemetry()).toMatchObject({ build_revision: "1a2b3c4" });
      process.env.SENTRY_RELEASE = "not-a-sha";
      expect(mcpRuntimeTelemetry()).toMatchObject({ build_revision: "unknown" });
    } finally {
      if (original === undefined) delete process.env.SENTRY_RELEASE;
      else process.env.SENTRY_RELEASE = original;
    }
  });

  it("uses the initialize body protocol version when the header is absent", () => {
    expect(
      mcpRequestTelemetry(
        { method: "initialize", params: { protocolVersion: "2025-03-26" } },
        undefined,
      ),
    ).toMatchObject({ protocol_version: "2025-03-26" });
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

  it("reports missing expected tools, invalid schemas, and an exhausted page", () => {
    const telemetry = mcpToolsListResponseTelemetry({
      result: { tools: [{ inputSchema: null, name: "create_food_entry" }] },
    });

    expect(telemetry).toMatchObject({
      jsonrpc_outcome: "result",
      tools_count: 1,
      expected_food_tools_present: false,
      has_next_page: false,
      tool_schema_valid: false,
    });
    expect(mcpToolsListResponseTelemetry(null)).toEqual({ jsonrpc_outcome: "invalid" });
  });
});
