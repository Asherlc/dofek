import { Client } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderAccessDeniedError, ProviderAuthorizationFailedError } from "../auth-errors.ts";
import { TRAILFORKS_MCP_RESOURCE } from "./auth.ts";
import {
  TRAILFORKS_MCP_ACCESS_DENIED_MESSAGE,
  TrailforksActivityClient,
  TrailforksMcpToolError,
} from "./client.ts";

const telemetryMocks = vi.hoisted(() => ({ captureException: vi.fn() }));

vi.mock("../../lib/error-reporting.ts", () => ({
  captureException: (...args: unknown[]) => telemetryMocks.captureException(...args),
}));

type JsonRpcMethod =
  | "initialize"
  | "notifications/initialized"
  | "notifications/cancelled"
  | "tools/call";

interface FakeHarness {
  fetch: typeof globalThis.fetch;
  urls: string[];
  jsonRpcMethods: JsonRpcMethod[];
  bearerHeaders: Array<string | null>;
  initializeParams: unknown[];
  toolCalls: Array<{ name: string; arguments: Record<string, unknown> }>;
  initializedNotifications: number;
  transportClosed: boolean;
}

const ACCESS_TOKEN = "synthetic-trailforks-access-token";
const JSON_RPC_METHODS = new Set<string>([
  "initialize",
  "notifications/initialized",
  "notifications/cancelled",
  "tools/call",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isJsonRpcMethod(value: unknown): value is JsonRpcMethod {
  return typeof value === "string" && JSON_RPC_METHODS.has(value);
}

function createFakeTrailforksMcpHarness(
  options: {
    callResult?: unknown;
    httpStatus?: number;
    httpBody?: string;
    bodyCancel?: () => void;
  } = {},
): FakeHarness {
  const urls: string[] = [];
  const jsonRpcMethods: JsonRpcMethod[] = [];
  const bearerHeaders: Array<string | null> = [];
  const initializeParams: unknown[] = [];
  const toolCalls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  let initializedNotifications = 0;
  let transportClosed = false;
  const observedSignals = new WeakSet<AbortSignal>();

  const fakeFetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    urls.push(request.url);
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

    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }

    if (options.httpStatus !== undefined) {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(options.httpBody ?? "upstream body"));
        },
      });
      if (options.bodyCancel) {
        const originalCancel = stream.cancel.bind(stream);
        stream.cancel = async (reason) => {
          options.bodyCancel?.();
          return originalCancel(reason);
        };
      }
      return new Response(stream, { status: options.httpStatus });
    }

    const body: unknown = await request.json();
    if (!isRecord(body) || body.jsonrpc !== "2.0" || !isJsonRpcMethod(body.method)) {
      throw new Error("Expected an MCP JSON-RPC request");
    }
    const method = body.method;
    jsonRpcMethods.push(method);

    switch (method) {
      case "initialize":
        if (body.id === undefined) throw new Error("initialize must have a JSON-RPC ID");
        initializeParams.push(body.params);
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-06-18",
            capabilities: { tools: {} },
            serverInfo: { name: "fake-trailforks", version: "1" },
          },
        });
      case "notifications/initialized":
        initializedNotifications += 1;
        return new Response(null, { status: 202 });
      case "notifications/cancelled":
        return new Response(null, { status: 202 });
      case "tools/call": {
        if (body.id === undefined) throw new Error("tools/call must have a JSON-RPC ID");
        const params = body.params;
        if (!isRecord(params) || typeof params.name !== "string" || !isRecord(params.arguments)) {
          throw new Error("tools/call must contain a tool name and object arguments");
        }
        toolCalls.push({ name: params.name, arguments: params.arguments });
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: options.callResult ?? {
            content: [{ type: "text", text: '{"activities":[]}' }],
          },
        });
      }
    }
  };

  return {
    fetch: fakeFetch,
    urls,
    jsonRpcMethods,
    bearerHeaders,
    initializeParams,
    toolCalls,
    get initializedNotifications() {
      return initializedNotifications;
    },
    get transportClosed() {
      return transportClosed;
    },
  };
}

async function withClient<T>(
  harness: FakeHarness,
  operation: (client: TrailforksActivityClient) => Promise<T>,
): Promise<T> {
  const client = await TrailforksActivityClient.connect({
    accessToken: ACCESS_TOKEN,
    fetchFn: harness.fetch,
  });
  try {
    return await operation(client);
  } finally {
    await client.close();
    expect(harness.transportClosed).toBe(true);
  }
}

describe("TrailforksActivityClient", () => {
  afterEach(() => {
    telemetryMocks.captureException.mockReset();
  });

  it("initializes against the fixed MCP account endpoint with OAuth bearer auth", async () => {
    const harness = createFakeTrailforksMcpHarness();

    await withClient(harness, async () => undefined);

    expect(harness.urls.every((url) => url === TRAILFORKS_MCP_RESOURCE)).toBe(true);
    expect(harness.jsonRpcMethods.slice(0, 2)).toEqual(["initialize", "notifications/initialized"]);
    expect(harness.initializedNotifications).toBe(1);
    expect(harness.initializeParams).toEqual([
      expect.objectContaining({
        clientInfo: expect.objectContaining({
          name: "dofek-trailforks",
          version: expect.any(String),
        }),
        capabilities: {},
      }),
    ]);
    expect(harness.bearerHeaders.every((header) => header === `Bearer ${ACCESS_TOKEN}`)).toBe(true);
  });

  it("calls only list_my_activities with caller-supplied JSON arguments and returns the opaque MCP result", async () => {
    const opaqueResult = {
      content: [{ type: "text", text: '{"opaque":true,"activities":[{"id":"keep-raw"}]}' }],
      structuredContent: { keep: "opaque-until-observed" },
    };
    const harness = createFakeTrailforksMcpHarness({ callResult: opaqueResult });
    const args = { cursor: "page-token", view: "compact", rows: 25 };

    const result = await withClient(harness, (client) => client.listMyActivities(args));

    expect(result).toEqual(opaqueResult);
    expect(harness.toolCalls).toEqual([{ name: "list_my_activities", arguments: args }]);
  });

  it("treats an HTTP-success MCP isError result as an actionable redacted tool failure", async () => {
    const privateMessage = "user-private trailforks tool failure body";
    const harness = createFakeTrailforksMcpHarness({
      callResult: {
        isError: true,
        content: [{ type: "text", text: privateMessage }],
      },
    });

    const promise = withClient(harness, (client) => client.listMyActivities({}));
    await expect(promise).rejects.toBeInstanceOf(TrailforksMcpToolError);
    await expect(promise).rejects.toMatchObject({
      name: "TrailforksMcpToolError",
      message: "Trailforks could not complete the activity list.",
    });
    await expect(promise).rejects.not.toThrow(privateMessage);
  });

  it("maps MCP HTTP 401 to a provider auth error without the remote body", async () => {
    const remoteBodyMarker = "REMOTE_401_private_activity_body";
    const bodyCancel = vi.fn();
    const harness = createFakeTrailforksMcpHarness({
      httpStatus: 401,
      httpBody: remoteBodyMarker,
      bodyCancel,
    });

    let caught: unknown;
    try {
      await TrailforksActivityClient.connect({
        accessToken: ACCESS_TOKEN,
        fetchFn: harness.fetch,
      });
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ProviderAuthorizationFailedError);
    expect(caught).toMatchObject({
      authFailureReason: "authorization_failed",
      message: "Trailforks authorization failed.",
    });
    expect(String(caught)).not.toContain(remoteBodyMarker);
    expect(bodyCancel).toHaveBeenCalled();
  });

  it("maps MCP HTTP 403 to safe Pro/Outside+ access denial guidance", async () => {
    const remoteBodyMarker = "REMOTE_403_scope_or_subscription_body";
    const bodyCancel = vi.fn();
    const harness = createFakeTrailforksMcpHarness({
      httpStatus: 403,
      httpBody: remoteBodyMarker,
      bodyCancel,
    });

    let caught: unknown;
    try {
      await TrailforksActivityClient.connect({
        accessToken: ACCESS_TOKEN,
        fetchFn: harness.fetch,
      });
    } catch (error: unknown) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ProviderAccessDeniedError);
    expect(caught).toMatchObject({ message: TRAILFORKS_MCP_ACCESS_DENIED_MESSAGE });
    expect(String(caught)).not.toContain(remoteBodyMarker);
    expect(bodyCancel).toHaveBeenCalled();
  });

  it("classifies an empty HTTP 401 response as an authorization failure", async () => {
    await expect(
      TrailforksActivityClient.connect({
        accessToken: ACCESS_TOKEN,
        fetchFn: async () => new Response(null, { status: 401 }),
      }),
    ).rejects.toBeInstanceOf(ProviderAuthorizationFailedError);
  });

  it("honors an already-aborted run signal during connect", async () => {
    const harness = createFakeTrailforksMcpHarness();
    const signal = AbortSignal.abort();

    await expect(
      TrailforksActivityClient.connect({
        accessToken: ACCESS_TOKEN,
        fetchFn: harness.fetch,
        signal,
      }),
    ).rejects.toThrow(/AbortError|aborted/i);
  });

  it("propagates a run cancellation to the requests opened by the SDK", async () => {
    const harness = createFakeTrailforksMcpHarness();
    const controller = new AbortController();
    const observedSignals: AbortSignal[] = [];
    const fetchFn: typeof globalThis.fetch = (input, init) => {
      if (init?.signal) observedSignals.push(init.signal);
      return harness.fetch(input, init);
    };
    const client = await TrailforksActivityClient.connect({
      accessToken: ACCESS_TOKEN,
      fetchFn,
      signal: controller.signal,
    });
    try {
      await client.listMyActivities({});
      expect(observedSignals.length).toBeGreaterThan(1);
      expect(observedSignals.every((signal) => !signal.aborted)).toBe(true);
      controller.abort();
      expect(observedSignals.every((signal) => signal.aborted)).toBe(true);
    } finally {
      await client.close();
    }
  });

  it("preserves the connect failure and reports a failed SDK close without private details", async () => {
    const connectFailure = new Error("handshake failed");
    vi.spyOn(Client.prototype, "connect").mockRejectedValueOnce(connectFailure);
    const close = vi
      .spyOn(Client.prototype, "close")
      .mockRejectedValueOnce(new TypeError("private cleanup body"));

    await expect(TrailforksActivityClient.connect({ accessToken: ACCESS_TOKEN })).rejects.toBe(
      connectFailure,
    );

    expect(close).toHaveBeenCalledOnce();
    expect(telemetryMocks.captureException).toHaveBeenCalledWith(
      expect.any(TrailforksMcpToolError),
      {
        tags: { provider: "trailforks", mcpPhase: "close_after_connect_failure" },
        extra: { errorName: "TypeError" },
      },
    );
    expect(String(telemetryMocks.captureException.mock.calls[0]?.[0])).not.toContain(
      "private cleanup body",
    );
  });
});
