import type { AddressInfo } from "node:net";
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createMcpRouter } from "./route.ts";
import { validateMcpToken } from "./token-repository.ts";
import { createDofekMcpServer } from "./tools.ts";

const toolTestMocks = vi.hoisted(() => {
  const mocks = {
    activityList: vi.fn(),
    dailyMetricsList: vi.fn(),
    ensureProvidersRegistered: vi.fn(),
    foodCreate: vi.fn(),
    getAllProviders: vi.fn(),
    getConnectedProviderIds: vi.fn(),
    getLastSyncTimes: vi.fn(),
    getLatestErrors: vi.fn(),
    getProviderSyncQueue: vi.fn(),
    queueAdd: vi.fn(),
    startWorker: vi.fn(),
  };
  return {
    ...mocks,
    activityRepository: vi.fn(() => ({ list: mocks.activityList })),
    dailyMetricsRepository: vi.fn(() => ({ list: mocks.dailyMetricsList })),
  };
});

vi.mock("./token-repository.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./token-repository.ts")>();
  return {
    ...original,
    validateMcpToken: vi.fn(),
  };
});

vi.mock("../repositories/activity-repository.ts", () => ({
  ActivityRepository: toolTestMocks.activityRepository,
}));

vi.mock("../repositories/daily-metrics-repository.ts", () => ({
  DailyMetricsRepository: toolTestMocks.dailyMetricsRepository,
}));

vi.mock("../repositories/food-repository.ts", () => ({
  FoodRepository: vi.fn(() => ({ create: toolTestMocks.foodCreate })),
}));

vi.mock("../repositories/sync-repository.ts", () => ({
  SyncRepository: vi.fn(() => ({
    getConnectedProviderIds: toolTestMocks.getConnectedProviderIds,
    getLastSyncTimes: toolTestMocks.getLastSyncTimes,
    getLatestErrors: toolTestMocks.getLatestErrors,
  })),
}));

vi.mock("../lib/start-worker.ts", () => ({
  startWorker: toolTestMocks.startWorker,
}));

vi.mock("../routers/sync-helpers.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../routers/sync-helpers.ts")>();
  return {
    ...original,
    ensureProvidersRegistered: toolTestMocks.ensureProvidersRegistered,
  };
});

vi.mock("dofek/jobs/queues", async (importOriginal) => {
  const original = await importOriginal<typeof import("dofek/jobs/queues")>();
  return {
    ...original,
    getProviderSyncQueue: toolTestMocks.getProviderSyncQueue,
  };
});

vi.mock("dofek/providers/registry", () => ({
  getAllProviders: toolTestMocks.getAllProviders,
  registerProvider: vi.fn(),
}));

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
}));

vi.mock("./tools.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./tools.ts")>();
  return {
    ...original,
    createDofekMcpServer: vi.fn(original.createDofekMcpServer),
  };
});

function getPort(server: ReturnType<express.Express["listen"]>): number {
  const address = server.address();
  if (address !== null && typeof address === "object") {
    return (address satisfies AddressInfo).port;
  }
  throw new Error("Server address is not an object");
}

async function request(
  app: express.Express,
  input: {
    body?: unknown;
    authorization?: string;
    method?: "DELETE" | "GET" | "POST";
    rawBody?: string;
    timezone?: string;
  },
): Promise<{ headers: Headers; status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = getPort(server);
      fetch(`http://localhost:${port}/api/mcp`, {
        method: input.method ?? "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          ...(input.authorization ? { Authorization: input.authorization } : {}),
          ...(input.timezone ? { "X-Timezone": input.timezone } : {}),
        },
        body: input.rawBody ?? JSON.stringify(input.body),
      })
        .then(async (response) => {
          const text = await response.text();
          resolve({
            headers: response.headers,
            status: response.status,
            text,
          });
          server.close();
        })
        .catch((error: unknown) => {
          server.close();
          reject(error);
        });
    });
  });
}

function createTestApp() {
  const app = express();
  app.use("/api/mcp", createMcpRouter({ db: { execute: vi.fn(), select: vi.fn() } }));
  return app;
}

const mcpScopes = [
  "health:read",
  "activity:read",
  "nutrition:write",
  "providers:read",
  "sync:write",
] as const;

const jsonRpcEnvelopeSchema = z.object({
  error: z.unknown().optional(),
  id: z.number().nullable(),
  jsonrpc: z.literal("2.0"),
  result: z.unknown().optional(),
});

const toolListResponseSchema = z.object({
  id: z.number(),
  jsonrpc: z.literal("2.0"),
  result: z.object({
    tools: z.array(
      z.object({
        description: z.string(),
        inputSchema: z.object({}).passthrough(),
        name: z.string(),
        title: z.string(),
      }),
    ),
  }),
});

const toolCallResponseSchema = z.object({
  id: z.number(),
  jsonrpc: z.literal("2.0"),
  result: z.object({
    content: z.array(z.object({ text: z.string(), type: z.literal("text") })),
    isError: z.boolean().optional(),
  }),
});

function parseJsonRpcEvent(text: string): unknown {
  const dataLine = text.split("\n").find((line) => line.startsWith("data: "));
  if (!dataLine) {
    return jsonRpcEnvelopeSchema.parse(JSON.parse(text));
  }
  return JSON.parse(dataLine.slice("data: ".length));
}

function parseToolCallText(responseText: string): unknown {
  const response = toolCallResponseSchema.parse(parseJsonRpcEvent(responseText));
  return JSON.parse(response.result.content[0]?.text ?? "null");
}

function authorizeMcpToken(scopes: readonly (typeof mcpScopes)[number][] = mcpScopes): void {
  vi.mocked(validateMcpToken).mockResolvedValue({
    scopes: [...scopes],
    tokenId: "token-id",
    userId: "user-id",
  });
}

function createToolCallRequest(name: string, toolArguments: Record<string, unknown>) {
  return {
    id: 2,
    jsonrpc: "2.0",
    method: "tools/call",
    params: {
      arguments: toolArguments,
      name,
    },
  };
}

function findListedTool(
  tools: z.infer<typeof toolListResponseSchema>["result"]["tools"],
  name: string,
) {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) {
    throw new Error(`Expected MCP tool to be listed: ${name}`);
  }
  return tool;
}

const initializeRequest = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "vitest", version: "1.0.0" },
  },
};

describe("createMcpRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateMcpToken).mockResolvedValue(null);
    toolTestMocks.activityList.mockResolvedValue({ items: [], totalCount: 0 });
    toolTestMocks.dailyMetricsList.mockResolvedValue([]);
    toolTestMocks.ensureProvidersRegistered.mockResolvedValue(undefined);
    toolTestMocks.foodCreate.mockResolvedValue(null);
    toolTestMocks.getAllProviders.mockReturnValue([]);
    toolTestMocks.getConnectedProviderIds.mockResolvedValue([]);
    toolTestMocks.getLastSyncTimes.mockResolvedValue([]);
    toolTestMocks.getLatestErrors.mockResolvedValue([]);
    toolTestMocks.getProviderSyncQueue.mockReturnValue({ add: toolTestMocks.queueAdd });
    toolTestMocks.queueAdd.mockResolvedValue({ id: "job-123" });
  });

  it("returns 401 with a bearer challenge when Authorization is missing", async () => {
    const response = await request(createTestApp(), { body: initializeRequest });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(jsonRpcEnvelopeSchema.parse(JSON.parse(response.text))).toEqual({
      error: { code: -32001, message: "MCP bearer token is required." },
      id: null,
      jsonrpc: "2.0",
    });
    expect(validateMcpToken).not.toHaveBeenCalled();
  });

  it("returns 401 without validating non-bearer authorization", async () => {
    const response = await request(createTestApp(), {
      authorization: "Token good-token",
      body: initializeRequest,
    });

    expect(response.status).toBe(401);
    expect(jsonRpcEnvelopeSchema.parse(JSON.parse(response.text))).toEqual({
      error: { code: -32001, message: "MCP bearer token is required." },
      id: null,
      jsonrpc: "2.0",
    });
    expect(validateMcpToken).not.toHaveBeenCalled();
  });

  it("returns 401 without validating an empty bearer token", async () => {
    const response = await request(createTestApp(), {
      authorization: "Bearer ",
      body: initializeRequest,
    });

    expect(response.status).toBe(401);
    expect(jsonRpcEnvelopeSchema.parse(JSON.parse(response.text))).toEqual({
      error: { code: -32001, message: "MCP bearer token is required." },
      id: null,
      jsonrpc: "2.0",
    });
    expect(validateMcpToken).not.toHaveBeenCalled();
  });

  it("returns 401 before parsing JSON when Authorization is missing", async () => {
    const response = await request(createTestApp(), { rawBody: "{" });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("returns 401 when the bearer token is invalid", async () => {
    const response = await request(createTestApp(), {
      authorization: "Bearer bad-token",
      body: initializeRequest,
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe("Bearer");
    expect(validateMcpToken).toHaveBeenCalledWith(expect.anything(), "bad-token");
  });

  it("returns JSON-RPC method errors for unsupported HTTP methods", async () => {
    const getResponse = await request(createTestApp(), { method: "GET" });
    const deleteResponse = await request(createTestApp(), { method: "DELETE" });

    expect(jsonRpcEnvelopeSchema.parse(JSON.parse(getResponse.text))).toEqual({
      error: { code: -32000, message: "Method not allowed." },
      id: null,
      jsonrpc: "2.0",
    });
    expect(getResponse.status).toBe(405);
    expect(jsonRpcEnvelopeSchema.parse(JSON.parse(deleteResponse.text))).toEqual({
      error: { code: -32000, message: "Method not allowed." },
      id: null,
      jsonrpc: "2.0",
    });
    expect(deleteResponse.status).toBe(405);
  });

  it("initializes MCP for a valid token", async () => {
    authorizeMcpToken();

    const response = await request(createTestApp(), {
      authorization: "Bearer good-token",
      body: initializeRequest,
    });

    expect(response.status).toBe(200);
    expect(response.text).toContain("dofek");
  });

  it("passes the request timezone into the MCP context", async () => {
    authorizeMcpToken();

    const response = await request(createTestApp(), {
      authorization: "Bearer good-token",
      body: initializeRequest,
      timezone: "America/Los_Angeles",
    });

    expect(response.status).toBe(200);
    expect(vi.mocked(createDofekMcpServer)).toHaveBeenCalledWith(
      expect.objectContaining({ timezone: "America/Los_Angeles" }),
    );
  });

  it("lists Dofek MCP tools for a valid token", async () => {
    authorizeMcpToken();

    const response = await request(createTestApp(), {
      authorization: "Bearer good-token",
      body: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/list",
      },
    });

    expect(response.status).toBe(200);
    expect(response.text).toContain("get_daily_health_summary");
    expect(response.text).toContain("start_provider_sync");
  });

  it("describes MCP tool input schemas for clients", async () => {
    authorizeMcpToken();

    const response = await request(createTestApp(), {
      authorization: "Bearer good-token",
      body: {
        id: 2,
        jsonrpc: "2.0",
        method: "tools/list",
      },
    });

    const parsedResponse = toolListResponseSchema.parse(parseJsonRpcEvent(response.text));
    const tools = parsedResponse.result.tools;
    expect(findListedTool(tools, "get_daily_health_summary").inputSchema).toMatchObject({
      properties: {
        date: { pattern: "^\\d{4}-\\d{2}-\\d{2}$", type: "string" },
        timezone: { type: "string" },
      },
      required: ["date"],
      type: "object",
    });
    expect(findListedTool(tools, "search_activities").inputSchema).toMatchObject({
      properties: {
        from: { pattern: "^\\d{4}-\\d{2}-\\d{2}$", type: "string" },
        limit: { maximum: 25, minimum: 1, type: "integer" },
        query: { maxLength: 200, type: "string" },
        to: { pattern: "^\\d{4}-\\d{2}-\\d{2}$", type: "string" },
      },
      type: "object",
    });
    expect(findListedTool(tools, "log_food").inputSchema).toMatchObject({
      properties: {
        mealType: { enum: ["breakfast", "lunch", "dinner", "snack", "other"], type: "string" },
        occurredAt: { format: "date-time", type: "string" },
        text: { maxLength: 500, minLength: 1, type: "string" },
      },
      required: ["text"],
      type: "object",
    });
    expect(findListedTool(tools, "list_providers").inputSchema).toMatchObject({
      properties: {},
      type: "object",
    });
    expect(findListedTool(tools, "start_provider_sync").inputSchema).toMatchObject({
      properties: {
        providerId: { minLength: 1, type: "string" },
        sinceDays: { exclusiveMinimum: 0, type: "integer" },
      },
      required: ["providerId"],
      type: "object",
    });
  });

  it("returns daily health summaries from the metrics repository", async () => {
    authorizeMcpToken();
    toolTestMocks.dailyMetricsList.mockResolvedValue([
      { date: "2026-05-20", restingHeartRate: 52 },
    ]);

    const response = await request(createTestApp(), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("get_daily_health_summary", {
        date: "2026-05-20",
        timezone: "America/Los_Angeles",
      }),
    });

    expect(parseToolCallText(response.text)).toEqual({
      date: "2026-05-20",
      restingHeartRate: 52,
    });
    expect(toolTestMocks.dailyMetricsRepository).toHaveBeenCalledWith(
      expect.anything(),
      "user-id",
      "America/Los_Angeles",
    );
    expect(toolTestMocks.dailyMetricsList).toHaveBeenCalledWith(1, "2026-05-20");
  });

  it("searches activities and applies the query filter", async () => {
    authorizeMcpToken();
    toolTestMocks.activityList.mockResolvedValue({
      items: [
        { activity_type: "cycling", name: "Morning Ride" },
        { activity_type: "swim", name: "Pool" },
      ],
      totalCount: 2,
    });

    const response = await request(createTestApp(), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("search_activities", {
        from: "2026-05-10",
        limit: 5,
        query: "cycling",
        to: "2026-05-18",
      }),
    });

    expect(parseToolCallText(response.text)).toEqual({
      items: [{ activity_type: "cycling", name: "Morning Ride" }],
      totalCount: 2,
    });
    expect(toolTestMocks.activityRepository).toHaveBeenCalledWith(
      expect.anything(),
      "user-id",
      "UTC",
      { kind: "full", paid: true, reason: "paid_grant" },
      undefined,
    );
    expect(toolTestMocks.activityList).toHaveBeenCalledWith({
      days: 8,
      endDate: "2026-05-18",
      limit: 5,
      offset: 0,
    });
  });

  it("returns unfiltered activities when no search query is provided", async () => {
    authorizeMcpToken();
    toolTestMocks.activityList.mockResolvedValue({
      items: [
        { activity_type: "cycling", name: "Morning Ride" },
        { activity_type: "swim", name: "Pool" },
      ],
      totalCount: 2,
    });

    const response = await request(createTestApp(), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("search_activities", {
        to: "2026-05-18",
      }),
    });

    expect(parseToolCallText(response.text)).toEqual({
      items: [
        { activity_type: "cycling", name: "Morning Ride" },
        { activity_type: "swim", name: "Pool" },
      ],
      totalCount: 2,
    });
  });

  it("matches activity searches against activity names", async () => {
    authorizeMcpToken();
    toolTestMocks.activityList.mockResolvedValue({
      items: [
        { activity_type: "cycling", name: "Morning Ride" },
        { activity_type: "swim", name: "Pool" },
      ],
      totalCount: 2,
    });

    const response = await request(createTestApp(), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("search_activities", {
        query: "ride",
        to: "2026-05-18",
      }),
    });

    expect(parseToolCallText(response.text)).toEqual({
      items: [{ activity_type: "cycling", name: "Morning Ride" }],
      totalCount: 2,
    });
  });

  it("logs food entries with the requested meal type and local date", async () => {
    authorizeMcpToken();
    toolTestMocks.foodCreate.mockResolvedValue({
      foodName: "oatmeal with berries",
      meal: "breakfast",
    });

    const response = await request(createTestApp(), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("log_food", {
        mealType: "breakfast",
        occurredAt: "2026-05-20T08:30:00.000Z",
        text: "oatmeal with berries",
      }),
    });

    expect(parseToolCallText(response.text)).toEqual({
      foodName: "oatmeal with berries",
      meal: "breakfast",
    });
    expect(toolTestMocks.foodCreate).toHaveBeenCalledWith({
      date: "2026-05-20",
      foodName: "oatmeal with berries",
      meal: "breakfast",
      nutrients: {},
    });
  });

  it("lists configured providers with connection and reauth state", async () => {
    authorizeMcpToken();
    toolTestMocks.getConnectedProviderIds.mockResolvedValue([
      { providerId: "fitbit" },
      { providerId: "wahoo" },
    ]);
    toolTestMocks.getLastSyncTimes.mockResolvedValue([
      { lastSynced: "2026-05-20T12:00:00.000Z", providerId: "wahoo" },
    ]);
    toolTestMocks.getLatestErrors.mockResolvedValue([
      { authFailureReason: null, errorMessage: "rate limit exceeded", providerId: "fitbit" },
      { authFailureReason: null, errorMessage: "token expired", providerId: "strava" },
      {
        authFailureReason: "access_token_expired",
        errorMessage: "Wahoo access token expired.",
        providerId: "wahoo",
      },
    ]);
    toolTestMocks.getAllProviders.mockReturnValue([
      {
        authSetup: () => ({ oauthConfig: {} }),
        id: "fitbit",
        name: "Fitbit",
        validate: () => null,
      },
      {
        authSetup: () => ({ oauthConfig: {} }),
        id: "strava",
        name: "Strava",
        validate: () => null,
      },
      {
        authSetup: () => ({ oauthConfig: {} }),
        id: "wahoo",
        name: "Wahoo",
        validate: () => null,
      },
      {
        id: "missing",
        name: "Missing",
        validate: () => "missing credentials",
      },
    ]);

    const response = await request(createTestApp(), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("list_providers", {}),
    });

    expect(parseToolCallText(response.text)).toEqual([
      {
        authType: "oauth",
        authorized: true,
        id: "fitbit",
        importOnly: false,
        lastSyncedAt: null,
        name: "Fitbit",
        needsReauth: false,
      },
      {
        authType: "oauth",
        authorized: false,
        id: "strava",
        importOnly: false,
        lastSyncedAt: null,
        name: "Strava",
        needsReauth: false,
      },
      {
        authType: "oauth",
        authorized: true,
        id: "wahoo",
        importOnly: false,
        lastSyncedAt: "2026-05-20T12:00:00.000Z",
        name: "Wahoo",
        needsReauth: true,
      },
    ]);
  });

  it("enqueues provider sync jobs for configured providers", async () => {
    authorizeMcpToken();
    toolTestMocks.getAllProviders.mockReturnValue([
      {
        id: "strava",
        name: "Strava",
        validate: () => "wrong provider selected",
      },
      { id: "wahoo", name: "Wahoo", validate: () => null },
    ]);

    const response = await request(createTestApp(), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("start_provider_sync", {
        providerId: "wahoo",
        sinceDays: 7,
      }),
    });

    expect(toolTestMocks.getProviderSyncQueue).toHaveBeenCalledWith("wahoo");
    expect(toolTestMocks.queueAdd).toHaveBeenCalledWith(
      "sync",
      {
        providerId: "wahoo",
        sinceDays: 7,
        sinceIso: expect.any(String),
        targetRefreshWindow: { days: 7, type: "days" },
        userId: "user-id",
      },
      expect.objectContaining({ attempts: expect.any(Number) }),
    );
    expect(toolTestMocks.startWorker).toHaveBeenCalledTimes(1);
    expect(parseToolCallText(response.text)).toEqual({
      jobId: "wahoo:job-123",
      providerId: "wahoo",
      queueName: "sync-wahoo",
      status: "queued",
    });
  });

  it("returns tool errors for unknown providers", async () => {
    authorizeMcpToken();

    const response = await request(createTestApp(), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("start_provider_sync", {
        providerId: "missing",
      }),
    });

    const parsedResponse = toolCallResponseSchema.parse(parseJsonRpcEvent(response.text));
    expect(parsedResponse.result.isError).toBe(true);
    expect(parsedResponse.result.content[0]?.text).toBe("Unknown provider: missing");
  });

  it("returns tool errors for unconfigured providers", async () => {
    authorizeMcpToken();
    toolTestMocks.getAllProviders.mockReturnValue([
      {
        id: "wahoo",
        name: "Wahoo",
        validate: () => "missing API key",
      },
    ]);

    const response = await request(createTestApp(), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("start_provider_sync", {
        providerId: "wahoo",
      }),
    });

    const parsedResponse = toolCallResponseSchema.parse(parseJsonRpcEvent(response.text));
    expect(parsedResponse.result.isError).toBe(true);
    expect(parsedResponse.result.content[0]?.text).toBe("Provider not configured: missing API key");
  });

  it("returns tool-level insufficient scope errors", async () => {
    authorizeMcpToken(["health:read"]);

    const response = await request(createTestApp(), {
      authorization: "Bearer read-only-token",
      body: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: "start_provider_sync",
          arguments: { providerId: "wahoo" },
        },
      },
    });

    expect(response.status).toBe(200);
    expect(response.text).toContain("requires scope: sync:write");
  });
});
