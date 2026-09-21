type JsonRpcMethod =
  | "initialize"
  | "notifications/initialized"
  | "notifications/cancelled"
  | "tools/list"
  | "tools/call";

export interface FakeMcpTool {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, object>;
    required?: string[];
    [key: string]: unknown;
  };
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export const VERIFIED_ZIVA_MEAL_TOOL: FakeMcpTool = {
  name: "get_meals_for_date",
  description: "Returns saved meals for a diary date.",
  inputSchema: {
    type: "object",
    properties: {
      start_date: {
        anyOf: [{ type: "string", format: "date" }, { type: "null" }],
      },
      end_date: {
        anyOf: [{ type: "string", format: "date" }, { type: "null" }],
      },
    },
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
};

interface FakeHttpError {
  status: number;
  body: string;
  headers?: HeadersInit;
}

interface FakeJsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface FakeZivaMcpOptions {
  toolPages?: FakeMcpTool[][];
  callResult?: unknown;
  httpErrors?: Partial<Record<JsonRpcMethod, FakeHttpError>>;
  jsonRpcErrors?: Partial<Record<JsonRpcMethod, FakeJsonRpcError>>;
  thrownErrors?: Partial<Record<JsonRpcMethod, Error>>;
  delayedMethods?: Partial<Record<JsonRpcMethod, number>>;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: JsonRpcMethod;
  params?: Record<string, unknown>;
}

const JSON_RPC_METHODS = new Set<string>([
  "initialize",
  "notifications/initialized",
  "notifications/cancelled",
  "tools/list",
  "tools/call",
]);

export interface FakeZivaMcpHarness {
  fetch: typeof globalThis.fetch;
  urls: string[];
  httpMethods: string[];
  jsonRpcMethods: JsonRpcMethod[];
  bearerHeaders: Array<string | null>;
  listCursors: Array<string | null>;
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
  initializedNotifications: number;
  cancellationNotifications: number;
  transportClosed: boolean;
}

function jsonResponse(id: string | number, result: unknown): Response {
  return Response.json({ jsonrpc: "2.0", id, result });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRpcMethod(value: unknown): value is JsonRpcMethod {
  return typeof value === "string" && JSON_RPC_METHODS.has(value);
}

function parseJsonRpcRequest(value: unknown): JsonRpcRequest {
  if (!isRecord(value) || value.jsonrpc !== "2.0" || !isJsonRpcMethod(value.method)) {
    throw new Error("Expected an MCP JSON-RPC request");
  }
  if (value.id !== undefined && typeof value.id !== "string" && typeof value.id !== "number") {
    throw new Error("Expected a string or numeric JSON-RPC request ID");
  }
  if (value.params !== undefined && !isRecord(value.params)) {
    throw new Error("Expected object JSON-RPC parameters");
  }

  return {
    jsonrpc: "2.0",
    method: value.method,
    ...(value.id === undefined ? {} : { id: value.id }),
    ...(value.params === undefined ? {} : { params: value.params }),
  };
}

async function waitForConfiguredDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = Number.isFinite(delayMs) ? setTimeout(resolve, delayMs) : undefined;
    const abort = () => {
      if (timeout) clearTimeout(timeout);
      reject(signal.reason ?? new DOMException("The operation was aborted", "AbortError"));
    };

    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function createFakeZivaMcpHarness(options: FakeZivaMcpOptions = {}): FakeZivaMcpHarness {
  const toolPages = options.toolPages ?? [[structuredClone(VERIFIED_ZIVA_MEAL_TOOL)]];
  const urls: string[] = [];
  const httpMethods: string[] = [];
  const jsonRpcMethods: JsonRpcMethod[] = [];
  const bearerHeaders: Array<string | null> = [];
  const listCursors: Array<string | null> = [];
  const toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  let initializedNotifications = 0;
  let cancellationNotifications = 0;
  let transportClosed = false;
  const observedSignals = new WeakSet<AbortSignal>();

  const fakeFetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    urls.push(request.url);
    httpMethods.push(request.method);
    bearerHeaders.push(request.headers.get("authorization"));

    if (!observedSignals.has(request.signal)) {
      observedSignals.add(request.signal);
      request.signal.addEventListener(
        "abort",
        () => {
          transportClosed = true;
        },
        { once: true },
      );
    }

    if (request.method === "GET") {
      return new Response(null, { status: 405 });
    }

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    const message = parseJsonRpcRequest(await request.json());
    jsonRpcMethods.push(message.method);

    const configuredDelay = options.delayedMethods?.[message.method];
    if (configuredDelay !== undefined) {
      try {
        await waitForConfiguredDelay(configuredDelay, request.signal);
      } catch (error: unknown) {
        transportClosed = true;
        throw error;
      }
    }

    const configuredThrownError = options.thrownErrors?.[message.method];
    if (configuredThrownError) throw configuredThrownError;

    const configuredError = options.httpErrors?.[message.method];
    if (configuredError) {
      return new Response(configuredError.body, {
        status: configuredError.status,
        headers: configuredError.headers,
      });
    }

    const configuredJsonRpcError = options.jsonRpcErrors?.[message.method];
    if (configuredJsonRpcError) {
      if (message.id === undefined) {
        throw new Error("A JSON-RPC notification cannot receive an error response");
      }
      return Response.json({
        jsonrpc: "2.0",
        id: message.id,
        error: configuredJsonRpcError,
      });
    }

    switch (message.method) {
      case "initialize":
        if (message.id === undefined) throw new Error("initialize must have a JSON-RPC ID");
        return jsonResponse(message.id, {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "fake-ziva", version: "1" },
        });
      case "notifications/initialized":
        initializedNotifications += 1;
        return new Response(null, { status: 202 });
      case "notifications/cancelled":
        cancellationNotifications += 1;
        return new Response(null, { status: 202 });
      case "tools/list": {
        if (message.id === undefined) throw new Error("tools/list must have a JSON-RPC ID");
        const cursor =
          typeof message.params?.cursor === "string" ? message.params.cursor : undefined;
        listCursors.push(cursor ?? null);
        const pageIndex = cursor ? Number.parseInt(cursor.replace("page-", ""), 10) : 0;
        const tools = toolPages[pageIndex] ?? [];
        const nextCursor = pageIndex + 1 < toolPages.length ? `page-${pageIndex + 1}` : undefined;
        return jsonResponse(message.id, { tools, ...(nextCursor ? { nextCursor } : {}) });
      }
      case "tools/call": {
        if (message.id === undefined) throw new Error("tools/call must have a JSON-RPC ID");
        const name = message.params?.name;
        const argumentsValue = message.params?.arguments;
        if (typeof name !== "string" || !isRecord(argumentsValue)) {
          throw new Error("tools/call must contain a tool name and object arguments");
        }
        toolCalls.push({ name, arguments: argumentsValue });
        return jsonResponse(
          message.id,
          options.callResult ?? { content: [], structuredContent: { meals: [] } },
        );
      }
    }
  };

  return {
    fetch: fakeFetch,
    urls,
    httpMethods,
    jsonRpcMethods,
    bearerHeaders,
    listCursors,
    toolCalls,
    get initializedNotifications() {
      return initializedNotifications;
    },
    get cancellationNotifications() {
      return cancellationNotifications;
    },
    get transportClosed() {
      return transportClosed;
    },
  };
}
