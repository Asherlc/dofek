import { describe, expect, it } from "vitest";
import { ProviderAccessDeniedError, ProviderAuthorizationFailedError } from "../auth-errors.ts";
import { TRAILFORKS_MCP_RESOURCE } from "./auth.ts";
import {
  TRAILFORKS_MCP_ACCESS_DENIED_MESSAGE,
  TrailforksActivityClient,
  TrailforksMcpToolError,
} from "./client.ts";

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
  options: { callResult?: unknown; httpStatus?: number; httpBody?: string } = {},
): FakeHarness {
  const urls: string[] = [];
  const jsonRpcMethods: JsonRpcMethod[] = [];
  const bearerHeaders: Array<string | null> = [];
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
      return new Response(options.httpBody ?? "upstream body", { status: options.httpStatus });
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
  it("initializes against the fixed MCP account endpoint with OAuth bearer auth", async () => {
    const harness = createFakeTrailforksMcpHarness();

    await withClient(harness, async () => undefined);

    expect(harness.urls.every((url) => url === TRAILFORKS_MCP_RESOURCE)).toBe(true);
    expect(harness.jsonRpcMethods.slice(0, 2)).toEqual(["initialize", "notifications/initialized"]);
    expect(harness.initializedNotifications).toBe(1);
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
    const harness = createFakeTrailforksMcpHarness({
      httpStatus: 401,
      httpBody: remoteBodyMarker,
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
  });

  it("maps MCP HTTP 403 to safe Pro/Outside+ access denial guidance", async () => {
    const remoteBodyMarker = "REMOTE_403_scope_or_subscription_body";
    const harness = createFakeTrailforksMcpHarness({
      httpStatus: 403,
      httpBody: remoteBodyMarker,
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
  });
});
