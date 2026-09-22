import { HttpResponse, http } from "msw";
import { VERIFIED_ZIVA_MEAL_TOOL } from "./test-helpers.ts";

type ZivaMcpMethod =
  | "initialize"
  | "notifications/initialized"
  | "notifications/cancelled"
  | "tools/list"
  | "tools/call";

interface JsonRpcRequest {
  readonly id?: string | number;
  readonly method: ZivaMcpMethod;
  readonly params?: Record<string, unknown>;
}

export interface ZivaMswRequestRecord {
  readonly method: ZivaMcpMethod;
  readonly bearer: string | null;
  readonly sessionId: string | null;
  readonly date: string | null;
}

export interface ZivaMswCallContext {
  readonly bearer: string | null;
  readonly callIndex: number;
  readonly date: string;
  readonly sessionId: string | null;
}

export interface ZivaMswHarness {
  readonly handler: ReturnType<typeof http.all>;
  readonly requests: ZivaMswRequestRecord[];
  readonly initializedSessions: string[];
}

const MCP_METHODS = new Set<string>([
  "initialize",
  "notifications/initialized",
  "notifications/cancelled",
  "tools/list",
  "tools/call",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMcpMethod(value: unknown): value is ZivaMcpMethod {
  return typeof value === "string" && MCP_METHODS.has(value);
}

function parseJsonRpcRequest(value: unknown): JsonRpcRequest {
  if (!isRecord(value) || value.jsonrpc !== "2.0" || !isMcpMethod(value.method)) {
    throw new Error("Expected a Ziva MCP JSON-RPC request");
  }
  if (value.id !== undefined && typeof value.id !== "string" && typeof value.id !== "number") {
    throw new Error("Expected a string or numeric Ziva JSON-RPC request ID");
  }
  if (value.params !== undefined && !isRecord(value.params)) {
    throw new Error("Expected object Ziva JSON-RPC parameters");
  }
  return {
    method: value.method,
    ...(value.id === undefined ? {} : { id: value.id }),
    ...(value.params === undefined ? {} : { params: value.params }),
  };
}

function callDate(request: JsonRpcRequest): string | null {
  if (request.method !== "tools/call" || !isRecord(request.params?.arguments)) return null;
  return typeof request.params.arguments.start_date === "string"
    ? request.params.arguments.start_date
    : null;
}

function jsonRpcResult(
  id: string | number,
  result: unknown,
  headers?: Record<string, string>,
): Response {
  return HttpResponse.json({ jsonrpc: "2.0", id, result }, { headers });
}

export function createZivaMswHarness(
  resultForCall: (context: ZivaMswCallContext) => unknown | Response,
): ZivaMswHarness {
  const requests: ZivaMswRequestRecord[] = [];
  const initializedSessions: string[] = [];
  let callIndex = 0;

  const handler = http.all("https://connect.ziva.fit/mcp", async ({ request }) => {
    if (request.method === "GET") return new HttpResponse(null, { status: 405 });
    if (request.method === "DELETE") return new HttpResponse(null, { status: 200 });
    if (request.method !== "POST") {
      return new HttpResponse("Method not allowed", { status: 405 });
    }

    const message = parseJsonRpcRequest(await request.json());
    const bearer = request.headers.get("authorization");
    const sessionId = request.headers.get("mcp-session-id");
    const date = callDate(message);
    requests.push({ method: message.method, bearer, sessionId, date });

    switch (message.method) {
      case "initialize": {
        if (message.id === undefined) throw new Error("initialize requires a JSON-RPC ID");
        const newSessionId = `ziva-test-session-${initializedSessions.length + 1}`;
        initializedSessions.push(newSessionId);
        return jsonRpcResult(
          message.id,
          {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "fake-ziva-integration", version: "1" },
          },
          { "Mcp-Session-Id": newSessionId },
        );
      }
      case "notifications/initialized":
      case "notifications/cancelled":
        return new HttpResponse(null, { status: 202 });
      case "tools/list":
        if (message.id === undefined) throw new Error("tools/list requires a JSON-RPC ID");
        return jsonRpcResult(message.id, { tools: [structuredClone(VERIFIED_ZIVA_MEAL_TOOL)] });
      case "tools/call": {
        if (message.id === undefined) throw new Error("tools/call requires a JSON-RPC ID");
        if (!date) throw new Error("tools/call requires start_date");
        const response = resultForCall({ bearer, callIndex, date, sessionId });
        callIndex += 1;
        if (response instanceof Response) return response;
        return jsonRpcResult(message.id, response);
      }
    }
  });

  return { handler, requests, initializedSessions };
}
