import { HttpResponse, http } from "msw";
import { TRAILFORKS_MCP_RESOURCE } from "./auth.ts";

type TrailforksMcpMethod =
  | "initialize"
  | "notifications/initialized"
  | "notifications/cancelled"
  | "tools/call";

interface JsonRpcRequest {
  readonly id?: string | number;
  readonly method: TrailforksMcpMethod;
  readonly params?: Record<string, unknown>;
}

export interface TrailforksMswRequestRecord {
  readonly method: TrailforksMcpMethod;
  readonly bearer: string | null;
  readonly toolName: string | null;
  readonly toolArguments: Record<string, unknown> | null;
}

export interface TrailforksMswHarness {
  readonly handler: ReturnType<typeof http.all>;
  readonly requests: TrailforksMswRequestRecord[];
}

const MCP_METHODS = new Set<string>([
  "initialize",
  "notifications/initialized",
  "notifications/cancelled",
  "tools/call",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMcpMethod(value: unknown): value is TrailforksMcpMethod {
  return typeof value === "string" && MCP_METHODS.has(value);
}

function parseJsonRpcRequest(value: unknown): JsonRpcRequest {
  if (!isRecord(value) || value.jsonrpc !== "2.0" || !isMcpMethod(value.method)) {
    throw new Error("Expected a Trailforks MCP JSON-RPC request");
  }
  if (value.id !== undefined && typeof value.id !== "string" && typeof value.id !== "number") {
    throw new Error("Expected a string or numeric Trailforks JSON-RPC request ID");
  }
  if (value.params !== undefined && !isRecord(value.params)) {
    throw new Error("Expected object Trailforks JSON-RPC parameters");
  }
  return {
    method: value.method,
    ...(value.id === undefined ? {} : { id: value.id }),
    ...(value.params === undefined ? {} : { params: value.params }),
  };
}

function jsonRpcResult(
  id: string | number,
  result: unknown,
  headers?: Record<string, string>,
): Response {
  return HttpResponse.json({ jsonrpc: "2.0", id, result }, { headers });
}

/**
 * MSW harness for the Trailforks account MCP endpoint.
 * Call results are synthetic — not observed live Trailforks encodings.
 */
export function createTrailforksMswHarness(
  resultForCall: (context: {
    bearer: string | null;
    callIndex: number;
    toolName: string;
    toolArguments: Record<string, unknown>;
  }) => unknown | Response,
): TrailforksMswHarness {
  const requests: TrailforksMswRequestRecord[] = [];
  const initializedSessions: string[] = [];
  let callIndex = 0;

  const handler = http.all(TRAILFORKS_MCP_RESOURCE, async ({ request }) => {
    if (request.method === "GET") return new HttpResponse(null, { status: 405 });
    if (request.method === "DELETE") return new HttpResponse(null, { status: 200 });
    if (request.method !== "POST") {
      return new HttpResponse("Method not allowed", { status: 405 });
    }

    const message = parseJsonRpcRequest(await request.json());
    const bearer = request.headers.get("authorization");
    let toolName: string | null = null;
    let toolArguments: Record<string, unknown> | null = null;
    if (message.method === "tools/call" && isRecord(message.params)) {
      toolName = typeof message.params.name === "string" ? message.params.name : null;
      toolArguments = isRecord(message.params.arguments) ? message.params.arguments : null;
    }
    requests.push({ method: message.method, bearer, toolName, toolArguments });

    switch (message.method) {
      case "initialize": {
        if (message.id === undefined) throw new Error("initialize requires a JSON-RPC ID");
        const sessionId = `trailforks-test-session-${initializedSessions.length + 1}`;
        initializedSessions.push(sessionId);
        return jsonRpcResult(
          message.id,
          {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "fake-trailforks-integration", version: "1" },
          },
          { "Mcp-Session-Id": sessionId },
        );
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        return new HttpResponse(null, { status: 202 });
      case "tools/call": {
        if (message.id === undefined) throw new Error("tools/call requires a JSON-RPC ID");
        if (!toolName || !toolArguments) {
          throw new Error("tools/call requires a tool name and object arguments");
        }
        const response = resultForCall({
          bearer,
          callIndex,
          toolName,
          toolArguments,
        });
        callIndex += 1;
        if (response instanceof Response) return response;
        return jsonRpcResult(message.id, response);
      }
    }
  });

  return { handler, requests };
}
