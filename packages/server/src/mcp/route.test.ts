import type { AddressInfo } from "node:net";
import { healthExplorerSnapshotSchema } from "@dofek/mcp-contracts/health-explorer";
import { captureException } from "dofek/lib/error-reporting";
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { makeMockSensorStore } from "../routers/test-helpers.ts";
import { createMcpRouter } from "./route.ts";
import { validateMcpToken } from "./token-repository.ts";
import { activitySummaryOutputSchema, providersOutputSchema } from "./tool-output.ts";
import { createDofekMcpServer } from "./tools.ts";

const toolTestMocks = vi.hoisted(() => {
  const mocks = {
    activityList: vi.fn(),
    activityListRange: vi.fn(),
    activitySearch: vi.fn(),
    activityFindById: vi.fn(),
    activityGetStream: vi.fn(),
    bodyListReconciledRange: vi.fn(),
    climbingActivityEntries: vi.fn(),
    cyclingPerformanceListRange: vi.fn(),
    dailyMetricsList: vi.fn(),
    dailyMetricsListRange: vi.fn(),
    dataCoverageList: vi.fn(),
    ensureProvidersRegistered: vi.fn(),
    fingerLoadingRange: vi.fn(),
    foodDailyTotalsRange: vi.fn(),
    fingerLoadingActivity: vi.fn(),
    getAllProviders: vi.fn(),
    getConnectedProviderIds: vi.fn(),
    getLastSyncTimes: vi.fn(),
    getLatestErrors: vi.fn(),
    getScheduledSyncHealth: vi.fn(),
    getProviderSyncQueue: vi.fn(),
    queueAdd: vi.fn(),
    sleepListRange: vi.fn(),
    strengthExercises: vi.fn(),
    supplementsList: vi.fn(),
    subjectiveTimeline: vi.fn(),
    trainingLoadListRange: vi.fn(),
    withUserWriteFence: vi.fn(),
  };
  return {
    ...mocks,
    activityRepository: vi.fn(function vitestConstructor() {
      return {
        findById: mocks.activityFindById,
        getStream: mocks.activityGetStream,
        list: mocks.activityList,
        listRange: mocks.activityListRange,
        search: mocks.activitySearch,
      };
    }),
    dailyMetricsRepository: vi.fn(function vitestConstructor() {
      return { list: mocks.dailyMetricsList, listRange: mocks.dailyMetricsListRange };
    }),
    subjectiveRepository: vi.fn(function vitestConstructor() {
      return { timeline: mocks.subjectiveTimeline };
    }),
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

vi.mock("../repositories/climbing-repository.ts", () => ({
  ClimbingRepository: vi.fn(function vitestConstructor() {
    return { getActivityEntries: toolTestMocks.climbingActivityEntries };
  }),
}));

vi.mock("../repositories/daily-metrics-repository.ts", () => ({
  DailyMetricsRepository: toolTestMocks.dailyMetricsRepository,
}));

vi.mock("../repositories/data-coverage-repository.ts", () => ({
  DataCoverageRepository: vi.fn(function vitestConstructor() {
    return { list: toolTestMocks.dataCoverageList };
  }),
}));

vi.mock("../repositories/cycling-performance-repository.ts", () => ({
  CyclingPerformanceRepository: vi.fn(function vitestConstructor() {
    return { listRange: toolTestMocks.cyclingPerformanceListRange };
  }),
}));

vi.mock("../repositories/training-load-repository.ts", () => ({
  TrainingLoadRepository: vi.fn(function vitestConstructor() {
    return { listRange: toolTestMocks.trainingLoadListRange };
  }),
}));

vi.mock("../repositories/food-repository.ts", () => ({
  FoodRepository: vi.fn(function vitestConstructor() {
    return { dailyTotalsRange: toolTestMocks.foodDailyTotalsRange };
  }),
}));

vi.mock("../repositories/sleep-repository.ts", () => ({
  SleepRepository: vi.fn(function vitestConstructor() {
    return { listRange: toolTestMocks.sleepListRange };
  }),
}));

vi.mock("../repositories/body-repository.ts", () => ({
  BodyRepository: vi.fn(function vitestConstructor() {
    return { listReconciledRange: toolTestMocks.bodyListReconciledRange };
  }),
}));

vi.mock("../repositories/climbing-training-log-repository.ts", () => ({
  readFingerLoadingActivity: toolTestMocks.fingerLoadingActivity,
  readFingerLoadingRange: toolTestMocks.fingerLoadingRange,
}));

vi.mock("../repositories/strength-repository.ts", () => ({
  StrengthRepository: vi.fn(function vitestConstructor() {
    return { getExercisesForActivity: toolTestMocks.strengthExercises };
  }),
}));

vi.mock("../repositories/supplements-repository.ts", () => ({
  SupplementsRepository: vi.fn(function vitestConstructor() {
    return { list: toolTestMocks.supplementsList };
  }),
}));

vi.mock("../repositories/sync-repository.ts", () => ({
  SyncRepository: vi.fn(function vitestConstructor() {
    return {
      getConnectedProviderIds: toolTestMocks.getConnectedProviderIds,
      getLastSyncTimes: toolTestMocks.getLastSyncTimes,
      getLatestErrors: toolTestMocks.getLatestErrors,
      getScheduledSyncHealth: toolTestMocks.getScheduledSyncHealth,
    };
  }),
}));

vi.mock("../repositories/subjective-repository.ts", () => ({
  SubjectiveRepository: toolTestMocks.subjectiveRepository,
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

import * as enqueueSyncJobModule from "dofek/jobs/enqueue-sync-job";

vi.mock("@sentry/node", () => ({
  captureException: vi.fn(),
}));

vi.mock("dofek/lib/error-reporting", async (importOriginal) => {
  const original = await importOriginal<typeof import("dofek/lib/error-reporting")>();
  return { ...original, captureException: vi.fn() };
});

vi.mock("dofek/db/account-erasure", () => ({
  withAccountErasureUserWriteFence: (...args: unknown[]) =>
    toolTestMocks.withUserWriteFence(...args),
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

function createTestApp(sensorStore = undefined) {
  const app = express();
  app.use(
    "/api/mcp",
    createMcpRouter({
      db: { execute: vi.fn(), select: vi.fn(), transaction: vi.fn() },
      sensorStore,
    }),
  );
  return app;
}

const mcpScopes = [
  "health:read",
  "activity:read",
  "nutrition:read",
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
        annotations: z.object({ readOnlyHint: z.boolean().optional() }).optional(),
        description: z.string(),
        inputSchema: z.object({}).passthrough(),
        name: z.string(),
        outputSchema: z.object({}).passthrough(),
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
    structuredContent: z.unknown().optional(),
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
  if (response.result.isError) throw new Error(response.result.content[0]?.text);
  return JSON.parse(response.result.content[0]?.text ?? "null");
}

function authorizeMcpToken(scopes: readonly (typeof mcpScopes)[number][] = mcpScopes): void {
  vi.mocked(validateMcpToken).mockResolvedValue({
    expiresAt: null,
    oauthClientId: null,
    oauthResource: null,
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
    toolTestMocks.activityListRange.mockResolvedValue([]);
    toolTestMocks.activitySearch.mockResolvedValue({ items: [], totalCount: 0 });
    toolTestMocks.activityFindById.mockResolvedValue(null);
    toolTestMocks.bodyListReconciledRange.mockResolvedValue([]);
    toolTestMocks.climbingActivityEntries.mockResolvedValue([]);
    toolTestMocks.dailyMetricsList.mockResolvedValue([]);
    toolTestMocks.dailyMetricsListRange.mockResolvedValue([]);
    toolTestMocks.dataCoverageList.mockResolvedValue([]);
    toolTestMocks.ensureProvidersRegistered.mockResolvedValue(undefined);
    toolTestMocks.foodDailyTotalsRange.mockResolvedValue([]);
    toolTestMocks.fingerLoadingActivity.mockResolvedValue([]);
    toolTestMocks.fingerLoadingRange.mockResolvedValue([]);
    toolTestMocks.getAllProviders.mockReturnValue([]);
    toolTestMocks.getConnectedProviderIds.mockResolvedValue([]);
    toolTestMocks.getLastSyncTimes.mockResolvedValue([]);
    toolTestMocks.getLatestErrors.mockResolvedValue([]);
    toolTestMocks.getScheduledSyncHealth.mockResolvedValue([]);
    toolTestMocks.getProviderSyncQueue.mockReturnValue({
      add: toolTestMocks.queueAdd,
      getJob: vi.fn(),
    });
    toolTestMocks.queueAdd.mockResolvedValue({ id: "job-123" });
    toolTestMocks.sleepListRange.mockResolvedValue([]);
    toolTestMocks.strengthExercises.mockResolvedValue([]);
    toolTestMocks.subjectiveTimeline.mockResolvedValue({ checkIns: [], injuries: [] });
    toolTestMocks.withUserWriteFence.mockImplementation(
      async (
        database: unknown,
        _userId: string,
        operation: (transaction: unknown) => Promise<unknown>,
      ) => operation(database),
    );
  });

  it("returns 401 with a bearer challenge when Authorization is missing", async () => {
    const response = await request(createTestApp(), { body: initializeRequest });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer realm="dofek", resource_metadata="https://app.example.test/.well-known/oauth-protected-resource/api/mcp"',
    );
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
    expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
  });

  it("returns 401 when the bearer token is invalid", async () => {
    const response = await request(createTestApp(), {
      authorization: "Bearer bad-token",
      body: initializeRequest,
    });

    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
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
    expect(response.text).toContain("get_subjective_timeline");
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
    for (const tool of tools) {
      expect(tool.outputSchema).toMatchObject({ type: "object" });
    }
    expect(findListedTool(tools, "get_activity_summary").outputSchema).toMatchObject({
      properties: {
        result: {
          properties: {
            summaries: { type: "array" },
            unclassified_pct: { type: "number" },
          },
          type: "object",
        },
      },
    });
    expect(findListedTool(tools, "get_health_trends").description).toContain("HRV and step");
    expect(findListedTool(tools, "render_health_explorer").description).toContain(
      "interactive Dofek Analytics Explorer",
    );
    expect(findListedTool(tools, "get_sleep_summary").description).toContain("Summarize sleep");
    expect(findListedTool(tools, "search_activities").description).toContain(
      "optional date range (defaulting to the last 30 days)",
    );
    expect(findListedTool(tools, "list_providers").description).toContain(
      "configured Dofek providers",
    );
    expect(findListedTool(tools, "list_providers").description).toContain("last-sync timestamps");
    expect(findListedTool(tools, "get_daily_health_summary").inputSchema).toMatchObject({
      properties: {
        date: { format: "date", type: "string" },
        timezone: { type: "string" },
      },
      required: ["date"],
      type: "object",
    });
    expect(findListedTool(tools, "search_activities").inputSchema).toMatchObject({
      properties: {
        from: { format: "date", type: "string" },
        limit: { maximum: 25, minimum: 1, type: "integer" },
        include: { type: "array" },
        query: { maxLength: 200, type: "string" },
        to: { format: "date", type: "string" },
      },
      type: "object",
    });
    expect(findListedTool(tools, "get_health_trends").inputSchema).toMatchObject({
      properties: {
        end_date: { format: "date", type: "string" },
        granularity: { enum: ["daily", "weekly"], type: "string" },
        metrics: { type: "array" },
        start_date: { format: "date", type: "string" },
        timezone: { type: "string" },
      },
      required: ["start_date", "end_date"],
      type: "object",
    });
    expect(findListedTool(tools, "get_data_coverage").inputSchema).toMatchObject({
      properties: {},
      type: "object",
    });
    expect(findListedTool(tools, "get_training_load").inputSchema).toMatchObject({
      properties: {
        end_date: { format: "date", type: "string" },
        start_date: { format: "date", type: "string" },
      },
      required: ["start_date", "end_date"],
      type: "object",
    });
    expect(findListedTool(tools, "get_cycling_performance").inputSchema).toMatchObject({
      required: ["start_date", "end_date"],
      type: "object",
    });
    expect(findListedTool(tools, "render_health_explorer").inputSchema).toMatchObject({
      properties: {
        end_date: { format: "date", type: "string" },
        granularity: { enum: ["daily", "weekly"], type: "string" },
        metrics: { type: "array" },
        start_date: { format: "date", type: "string" },
      },
      required: ["start_date", "end_date"],
      type: "object",
    });
    expect(findListedTool(tools, "get_subjective_timeline").inputSchema).toMatchObject({
      properties: {
        end_date: { format: "date", type: "string" },
        start_date: { format: "date", type: "string" },
      },
      required: ["start_date", "end_date"],
      type: "object",
    });
    expect(findListedTool(tools, "get_sleep_summary").inputSchema).toMatchObject({
      required: ["start_date", "end_date"],
      type: "object",
    });
    expect(findListedTool(tools, "get_activity_summary").inputSchema).toMatchObject({
      properties: {
        canonical_types: { type: "array" },
        group_by: {
          enum: [
            "canonical_type",
            "week",
            "canonical_type_and_week",
            "canonical_type_and_modality",
            "canonical_type_and_purpose",
          ],
          type: "string",
        },
      },
      required: ["start_date", "end_date"],
      type: "object",
    });
    expect(findListedTool(tools, "get_finger_loading").inputSchema).toMatchObject({
      properties: {
        end_date: { format: "date", type: "string" },
        start_date: { format: "date", type: "string" },
        timezone: { type: "string" },
      },
      required: ["start_date", "end_date"],
      type: "object",
    });
    expect(findListedTool(tools, "get_climbing_sessions").inputSchema).toMatchObject({
      required: ["start_date", "end_date"],
      type: "object",
    });
    expect(findListedTool(tools, "get_strength_sessions").inputSchema).toMatchObject({
      required: ["start_date", "end_date"],
      type: "object",
    });
    expect(findListedTool(tools, "get_nutrition_summary").inputSchema).toMatchObject({
      required: ["start_date", "end_date"],
      type: "object",
    });
    expect(findListedTool(tools, "get_body_metrics").inputSchema).toMatchObject({
      required: ["start_date", "end_date"],
      type: "object",
    });
    expect(findListedTool(tools, "get_activity_details").inputSchema).toMatchObject({
      properties: { activity_id: { format: "uuid", type: "string" } },
      required: ["activity_id"],
      type: "object",
    });
    expect(findListedTool(tools, "get_activity_streams").inputSchema).toMatchObject({
      properties: {
        activity_id: { format: "uuid", type: "string" },
        channels: { type: "array" },
        downsample_to: { maximum: 2000, minimum: 1, type: "integer" },
      },
      required: ["activity_id"],
      type: "object",
    });
    expect(findListedTool(tools, "list_providers").inputSchema).toMatchObject({
      properties: {},
      type: "object",
    });
    expect(findListedTool(tools, "get_supplements").inputSchema).toMatchObject({
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
    for (const name of [
      "get_daily_health_summary",
      "get_health_trends",
      "get_data_coverage",
      "get_training_load",
      "get_cycling_performance",
      "get_sleep_summary",
      "search_activities",
      "get_activity_details",
      "get_activity_streams",
      "get_activity_summary",
      "get_finger_loading",
      "get_climbing_sessions",
      "get_strength_sessions",
      "get_nutrition_summary",
      "get_body_metrics",
      "get_subjective_timeline",
      "get_supplements",
      "list_providers",
      "render_health_explorer",
    ]) {
      expect(findListedTool(tools, name).annotations).toMatchObject({ readOnlyHint: true });
    }
    expect(findListedTool(tools, "start_provider_sync").annotations?.readOnlyHint).not.toBe(true);
  });

  it("returns object-root structured content for JSON tool calls", async () => {
    authorizeMcpToken();

    const activitySummaryResponse = await request(createTestApp(), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("get_activity_summary", {
        end_date: "2026-09-01",
        start_date: "2026-08-01",
      }),
    });
    const providersResponse = await request(createTestApp(), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("list_providers", {}),
    });

    expect(
      activitySummaryOutputSchema.parse(
        toolCallResponseSchema.parse(parseJsonRpcEvent(activitySummaryResponse.text)).result
          .structuredContent,
      ),
    ).toEqual({ result: { summaries: [], unclassified_pct: 0 } });
    expect(
      providersOutputSchema.parse(
        toolCallResponseSchema.parse(parseJsonRpcEvent(providersResponse.text)).result
          .structuredContent,
      ),
    ).toEqual({ result: [] });
  });

  it("returns a subjective timeline using the request context timezone", async () => {
    authorizeMcpToken();
    toolTestMocks.subjectiveTimeline.mockResolvedValue({
      checkIns: [],
      injuries: [],
    });

    const response = await request(createTestApp(), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("get_subjective_timeline", {
        end_date: "2026-05-20",
        start_date: "2026-05-01",
      }),
    });

    expect(response.status).toBe(200);
    expect(parseToolCallText(response.text)).toEqual({ checkIns: [], injuries: [] });
    expect(toolTestMocks.subjectiveRepository).toHaveBeenCalledWith(
      expect.anything(),
      "user-id",
      "UTC",
    );
    expect(toolTestMocks.subjectiveTimeline).toHaveBeenCalledWith("2026-05-01", "2026-05-20");
  });

  it("returns a tool error for a reversed subjective timeline range", async () => {
    authorizeMcpToken();

    const response = await request(createTestApp(), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("get_subjective_timeline", {
        end_date: "2026-05-01",
        start_date: "2026-05-20",
      }),
    });

    const parsedResponse = toolCallResponseSchema.parse(parseJsonRpcEvent(response.text));
    expect(parsedResponse.result.isError).toBe(true);
    expect(parsedResponse.result.content[0]?.text).toBe("start_date must be on or before end_date");
    expect(toolTestMocks.subjectiveTimeline).not.toHaveBeenCalled();
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

  it("returns structured finger loading with server-computed effective load", async () => {
    authorizeMcpToken();
    toolTestMocks.fingerLoadingRange.mockResolvedValue([
      {
        activityId: "activity-1",
        bodyweightKg: 72,
        edgeSizeMm: 20,
        effectiveLoadKg: 90,
        exercise: "max_hang",
        externalLoadKg: 18,
        gripPosition: "half_crimp",
        holdDurationSeconds: 10,
        laterality: "both",
        notes: null,
        restIntervalSeconds: 180,
        rpe: 8,
        setCount: 5,
        startedAt: "2026-07-29T18:00:00.000Z",
      },
    ]);

    const response = await request(createTestApp(), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("get_finger_loading", {
        end_date: "2026-07-29",
        start_date: "2026-07-29",
        timezone: "America/Los_Angeles",
      }),
    });

    expect(parseToolCallText(response.text)).toEqual([
      expect.objectContaining({
        activity_id: "activity-1",
        effective_load_kg: 90,
        effective_load_formula: "bodyweight_kg + external_load_kg",
        exercise: "max_hang",
        total_time_under_tension_seconds: 50,
      }),
    ]);
    expect(toolTestMocks.fingerLoadingRange).toHaveBeenCalledWith({
      database: expect.anything(),
      endDate: "2026-07-29",
      startDate: "2026-07-29",
      timezone: "America/Los_Angeles",
      userId: "user-id",
    });
  });

  it("returns climbing sessions with grade and send aggregates", async () => {
    authorizeMcpToken();
    toolTestMocks.activityListRange.mockResolvedValue([
      {
        avg_hr: 126,
        ended_at: "2026-07-09T20:30:00.000Z",
        id: "activity-1",
        name: "Pacific Pipe",
        started_at: "2026-07-09T19:00:00.000Z",
      },
    ]);
    toolTestMocks.climbingActivityEntries.mockResolvedValue([
      {
        toDetail: () => ({
          attemptCount: 3,
          climbType: "boulder",
          grade: "V5",
          gradeSystem: "v_scale",
          lead: null,
          locationName: "Pacific Pipe",
          routeName: "Blue Circuit",
          sent: true,
          wallAngleDegrees: 30,
        }),
      },
    ]);

    const response = await request(createTestApp(), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("get_climbing_sessions", {
        end_date: "2026-07-10",
        start_date: "2026-07-01",
      }),
    });

    expect(parseToolCallText(response.text)).toEqual({
      aggregates: {
        grade_distribution: [
          {
            attempts: 3,
            discipline: "boulder",
            grade: "V5",
            grade_system: "v_scale",
            sends: 1,
          },
        ],
        max_grade_by_discipline: { boulder: "V5", route: null },
        send_rate: 1,
        volume: { attempts: 3, climbs: 1, sends: 1, total_vertical_m: null },
      },
      sessions: [
        expect.objectContaining({
          activity_id: "activity-1",
          avg_hr: 126,
          duration_minutes: 90,
          gym_vs_crag: null,
          climbs: [
            expect.objectContaining({
              discipline: "boulder",
              wall_angle_degrees: 30,
            }),
          ],
          total_vertical_m: null,
        }),
      ],
    });
    expect(toolTestMocks.activityListRange).toHaveBeenCalledWith("2026-07-01", "2026-07-10", [
      "climbing",
    ]);
  });

  it("preserves route disciplines and incomplete climbing-session data", async () => {
    authorizeMcpToken();
    toolTestMocks.activityListRange.mockResolvedValue([
      {
        avg_hr: null,
        ended_at: null,
        id: "activity-2",
        name: null,
        started_at: "2026-07-11T19:00:00.000Z",
      },
    ]);
    toolTestMocks.climbingActivityEntries.mockResolvedValue([
      {
        toDetail: () => ({
          ascentType: "redpoint",
          attemptCount: 1,
          attempts: [],
          climbType: "route",
          grade: "5.10",
          gradeSystem: "yds",
          holdType: null,
          id: "climb-1",
          lead: true,
          locationName: null,
          routeName: "Lead route",
          sent: true,
          sourceName: "kaya",
          wallAngleDegrees: null,
        }),
      },
      {
        toDetail: () => ({
          ascentType: null,
          attemptCount: 2,
          attempts: [],
          climbType: "route",
          grade: "5.11",
          gradeSystem: "yds",
          holdType: null,
          id: "climb-2",
          lead: false,
          locationName: null,
          routeName: "Top-rope route",
          sent: false,
          sourceName: "kaya",
          wallAngleDegrees: null,
        }),
      },
      {
        toDetail: () => ({
          ascentType: "onsight",
          attemptCount: 1,
          attempts: [],
          climbType: "route",
          grade: "5.12",
          gradeSystem: "yds",
          holdType: null,
          id: "climb-3",
          lead: null,
          locationName: null,
          routeName: "Unspecified route",
          sent: true,
          sourceName: "mountain_project",
          wallAngleDegrees: null,
        }),
      },
      {
        toDetail: () => ({
          ascentType: null,
          attemptCount: 1,
          attempts: [],
          climbType: "route",
          grade: "not-a-grade",
          gradeSystem: "yds",
          holdType: null,
          id: "climb-4",
          lead: true,
          locationName: null,
          routeName: null,
          sent: true,
          sourceName: "kaya",
          wallAngleDegrees: null,
        }),
      },
      {
        toDetail: () => ({
          ascentType: null,
          attemptCount: 1,
          attempts: [],
          climbType: "route",
          grade: "5.10",
          gradeSystem: "yds",
          holdType: null,
          id: "climb-5",
          lead: true,
          locationName: null,
          routeName: "Lead route",
          sent: false,
          sourceName: "kaya",
          wallAngleDegrees: null,
        }),
      },
    ]);

    const response = await request(createTestApp(), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("get_climbing_sessions", {
        end_date: "2026-07-11",
        start_date: "2026-07-11",
      }),
    });

    expect(parseToolCallText(response.text)).toEqual({
      aggregates: {
        grade_distribution: [
          {
            attempts: 2,
            discipline: "lead",
            grade: "5.10",
            grade_system: "yds",
            sends: 1,
          },
          {
            attempts: 2,
            discipline: "top_rope",
            grade: "5.11",
            grade_system: "yds",
            sends: 0,
          },
          {
            attempts: 1,
            discipline: "route",
            grade: "5.12",
            grade_system: "yds",
            sends: 1,
          },
          {
            attempts: 1,
            discipline: "lead",
            grade: "not-a-grade",
            grade_system: "yds",
            sends: 1,
          },
        ],
        max_grade_by_discipline: { boulder: null, route: "5.12" },
        send_rate: 0.6,
        volume: { attempts: 6, climbs: 5, sends: 3, total_vertical_m: null },
      },
      sessions: [
        expect.objectContaining({
          activity_id: "activity-2",
          avg_hr: null,
          duration_minutes: null,
          location: null,
          name: null,
        }),
      ],
    });
  });

  it("returns strength sessions with volume-load by muscle group", async () => {
    authorizeMcpToken();
    toolTestMocks.activityListRange.mockResolvedValue([
      {
        avg_hr: 110,
        ended_at: "2026-07-09T20:00:00.000Z",
        id: "strength-1",
        name: "Upper Body",
        started_at: "2026-07-09T19:00:00.000Z",
      },
    ]);
    toolTestMocks.strengthExercises.mockResolvedValue([
      {
        toDetail: () => ({
          exerciseName: "Pull-up",
          muscleGroups: ["back"],
          sets: [{ durationSeconds: null, reps: 5, weightKg: 20 }],
        }),
      },
    ]);

    const response = await request(createTestApp(), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("get_strength_sessions", {
        end_date: "2026-07-10",
        start_date: "2026-07-01",
      }),
    });

    expect(parseToolCallText(response.text)).toEqual({
      aggregates: {
        by_muscle_group: [{ muscle_group: "back", volume_load_kg: 100 }],
        volume_load_kg: 100,
      },
      sessions: [
        expect.objectContaining({
          activity_id: "strength-1",
          avg_hr: 110,
          duration_minutes: 60,
          volume_load_kg: 100,
        }),
      ],
    });
  });

  it("searches activities and applies the query filter", async () => {
    authorizeMcpToken();
    toolTestMocks.activitySearch.mockResolvedValue({
      items: [{ canonical_type: "cycling", name: "Morning Ride" }],
      totalCount: 1,
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
      items: [{ canonical_type: "cycling", name: "Morning Ride" }],
      totalCount: 1,
    });
    expect(toolTestMocks.activityRepository).toHaveBeenCalledWith(
      expect.anything(),
      "user-id",
      "UTC",
      { kind: "full", paid: true, reason: "paid_grant" },
      undefined,
    );
    expect(toolTestMocks.activitySearch).toHaveBeenCalledWith({
      endDate: "2026-05-18",
      limit: 5,
      query: "cycling",
      startDate: "2026-05-10",
    });
  });

  it("reports search activity failures with safe tool context", async () => {
    authorizeMcpToken();
    const error = new Error("database search failed");
    toolTestMocks.activitySearch.mockRejectedValue(error);

    await request(createTestApp(), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("search_activities", {
        from: "2026-05-10",
        query: "private activity text",
        to: "2026-05-18",
      }),
    });

    expect(captureException).toHaveBeenCalledWith(error, {
      extra: {
        endDate: "2026-05-18",
        hasQuery: true,
        limit: 10,
        startDate: "2026-05-10",
      },
      tags: { mcp_tool: "search_activities" },
    });
    expect(captureException).not.toHaveBeenCalledWith(
      error,
      expect.objectContaining({ extra: expect.objectContaining({ query: expect.anything() }) }),
    );
  });

  it("omits map previews from activity search unless requested", async () => {
    authorizeMcpToken();
    toolTestMocks.activitySearch.mockResolvedValue({
      items: [
        {
          location: { centroidLat: 37.8, centroidLng: -122.4, mapPreview: { tiles: ["tile"] } },
          name: "Morning Ride",
        },
      ],
      totalCount: 1,
    });

    const response = await request(createTestApp(), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("search_activities", { to: "2026-05-18" }),
    });

    expect(parseToolCallText(response.text)).toEqual({
      items: [{ location: { centroidLat: 37.8, centroidLng: -122.4 }, name: "Morning Ride" }],
      totalCount: 1,
    });
  });

  it("returns weekly health metric aggregates for an exact date range", async () => {
    authorizeMcpToken();
    toolTestMocks.dailyMetricsListRange.mockResolvedValue([
      { date: "2026-05-17", hrv: 40, resting_hr: 57, steps: 6_000 },
      { date: "2026-05-18", hrv: 50, resting_hr: 55, steps: 8_000 },
      { date: "2026-05-19", hrv: 60, resting_hr: 53, steps: 10_000 },
    ]);

    const response = await request(createTestApp(makeMockSensorStore()), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("get_health_trends", {
        end_date: "2026-05-19",
        granularity: "weekly",
        metrics: ["hrv", "resting_hr", "steps"],
        start_date: "2026-05-18",
      }),
    });

    expect(parseToolCallText(response.text)).toMatchObject({
      range: {
        start_date: "2026-05-18",
        end_date: "2026-05-19",
        granularity: "weekly",
        timezone: "UTC",
      },
      requested_metrics: ["hrv", "resting_hr", "steps"],
      diagnostics: {
        metrics_with_no_data: [],
        range_clamped: false,
        earliest_available: null,
      },
      series: [
        expect.objectContaining({
          metric: "hrv",
          points: [
            expect.objectContaining({ key: "2026-W20", value: 40 }),
            expect.objectContaining({ key: "2026-W21", value: 55 }),
          ],
          summary: { average: 47.5, min: 40, max: 55 },
          coverage: expect.objectContaining({ observed_days: 2 }),
        }),
        expect.objectContaining({ metric: "resting_hr" }),
        expect.objectContaining({ metric: "steps" }),
      ],
    });
    expect(toolTestMocks.dailyMetricsListRange).toHaveBeenCalledWith(
      "2026-05-18",
      "2026-05-19",
      expect.anything(),
    );
  });

  it("returns default daily health trends with diagnostics for unavailable metrics", async () => {
    authorizeMcpToken();
    const sensorStore = makeMockSensorStore();
    toolTestMocks.dailyMetricsListRange.mockResolvedValue([
      { date: "2026-05-18", hrv: 50, steps: null },
      { date: "2026-05-19", hrv: null, steps: 10_000 },
    ]);

    const response = await request(createTestApp(sensorStore), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("get_health_trends", {
        end_date: "2026-05-19",
        start_date: "2026-05-18",
        timezone: "America/Los_Angeles",
      }),
    });

    expect(parseToolCallText(response.text)).toMatchObject({
      range: {
        start_date: "2026-05-18",
        end_date: "2026-05-19",
        granularity: "daily",
        timezone: "America/Los_Angeles",
      },
      diagnostics: {
        metrics_with_no_data: [
          "resting_hr",
          "spo2",
          "respiratory_rate",
          "sleep_efficiency",
          "skin_temp",
          "distance_km",
          "exercise_minutes",
          "flights_climbed",
        ],
        range_clamped: false,
        earliest_available: "2026-05-18",
      },
      series: expect.arrayContaining([
        expect.objectContaining({
          metric: "hrv",
          points: [
            expect.objectContaining({ key: "2026-05-18", value: 50 }),
            expect.objectContaining({ key: "2026-05-19", value: null }),
          ],
          coverage: expect.objectContaining({ observed_days: 1 }),
        }),
        expect.objectContaining({
          metric: "resting_hr",
          points: [],
          note: "no_data_in_range",
        }),
        expect.objectContaining({
          metric: "steps",
          points: [
            expect.objectContaining({ key: "2026-05-18", value: null }),
            expect.objectContaining({ key: "2026-05-19", value: 10_000 }),
          ],
        }),
      ]),
    });
    expect(vi.mocked(sensorStore.query).mock.calls[0]?.[2]).toMatchObject({
      rhrEndDate: "2026-05-19",
      rhrWindowStart: "2026-05-17",
      timezone: "America/Los_Angeles",
    });
  });

  it("returns first and last observed dates for every health metric", async () => {
    authorizeMcpToken();
    toolTestMocks.dataCoverageList.mockResolvedValue([
      {
        metric: "resting_hr",
        first_observed: "2026-03-09",
        last_observed: "2026-09-01",
        total_days_observed: 170,
        source_providers: ["apple_health"],
      },
    ]);

    const response = await request(createTestApp(makeMockSensorStore()), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("get_data_coverage", {}),
    });

    expect(parseToolCallText(response.text)).toEqual([
      {
        metric: "resting_hr",
        first_observed: "2026-03-09",
        last_observed: "2026-09-01",
        total_days_observed: 170,
        source_providers: ["apple_health"],
      },
    ]);
  });

  it("returns acute and chronic training load with window coverage", async () => {
    authorizeMcpToken();
    toolTestMocks.trainingLoadListRange.mockResolvedValue([
      {
        date: "2026-09-01",
        daily_load: 75,
        acute_load_7d: 420,
        chronic_load_28d: 350,
        workload_ratio: 1.2,
        coverage: { acute_window_days: 7, chronic_window_days: 28 },
      },
    ]);

    const response = await request(createTestApp(makeMockSensorStore()), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("get_training_load", {
        start_date: "2026-08-01",
        end_date: "2026-09-01",
      }),
    });

    expect(parseToolCallText(response.text)).toEqual({
      range: {
        start_date: "2026-08-01",
        end_date: "2026-09-01",
        timezone: "UTC",
      },
      rows: [
        {
          date: "2026-09-01",
          daily_load: 75,
          acute_load_7d: 420,
          chronic_load_28d: 350,
          workload_ratio: 1.2,
          coverage: { acute_window_days: 7, chronic_window_days: 28 },
        },
      ],
    });
    expect(toolTestMocks.trainingLoadListRange).toHaveBeenCalledWith("2026-08-01", "2026-09-01");
  });

  it("returns exact-range cycling performance and rolling power coverage", async () => {
    authorizeMcpToken();
    toolTestMocks.cyclingPerformanceListRange.mockResolvedValue({
      activities: [],
      rolling_90_day_best: { "5s": null, "1m": null, "5m": null, "20m": null },
      summary: {
        power_coverage: { activities_with_power: 0, activities_total: 0, pct: 0 },
        elevation_gain: {
          total_elevation_gain_m: null,
          avg_elevation_gain_m: null,
          coverage: { activities_with_elevation: 0, activities_total: 0, pct: 0 },
        },
      },
    });

    const response = await request(createTestApp(makeMockSensorStore()), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("get_cycling_performance", {
        start_date: "2026-08-01",
        end_date: "2026-09-01",
      }),
    });

    expect(parseToolCallText(response.text)).toEqual({
      range: { start_date: "2026-08-01", end_date: "2026-09-01", timezone: "UTC" },
      activities: [],
      rolling_90_day_best: { "5s": null, "1m": null, "5m": null, "20m": null },
      summary: {
        power_coverage: { activities_with_power: 0, activities_total: 0, pct: 0 },
        elevation_gain: {
          total_elevation_gain_m: null,
          avg_elevation_gain_m: null,
          coverage: { activities_with_elevation: 0, activities_total: 0, pct: 0 },
        },
      },
    });
    expect(toolTestMocks.cyclingPerformanceListRange).toHaveBeenCalledWith(
      "2026-08-01",
      "2026-09-01",
    );
  });

  it("distinguishes an out-of-range metric from a metric with no recorded history", async () => {
    authorizeMcpToken();
    toolTestMocks.dailyMetricsListRange.mockResolvedValue([]);
    toolTestMocks.dataCoverageList.mockResolvedValue([
      {
        metric: "resting_hr",
        first_observed: "2026-03-09",
        last_observed: "2026-09-01",
        total_days_observed: 170,
        source_providers: ["apple_health"],
      },
    ]);

    const response = await request(createTestApp(makeMockSensorStore()), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("get_health_trends", {
        start_date: "2023-06-01",
        end_date: "2023-08-01",
        metrics: ["resting_hr"],
      }),
    });

    expect(parseToolCallText(response.text)).toMatchObject({
      requested_metrics: ["resting_hr"],
      series: [
        {
          metric: "resting_hr",
          label: "Resting heart rate",
          unit: "bpm",
          points: [],
          note: "no_data_in_range",
          summary: { average: null, min: null, max: null },
          coverage: {
            observed_days: 0,
            missing_days_truncated_count: 32,
          },
        },
      ],
      diagnostics: {
        metrics_with_no_data: ["resting_hr"],
        range_clamped: true,
        earliest_available: "2026-03-09",
      },
    });
  });

  it("returns a structured analytics snapshot for the interactive explorer", async () => {
    authorizeMcpToken();
    toolTestMocks.dailyMetricsListRange.mockResolvedValue([
      { date: "2026-05-18", hrv: 50 },
      { date: "2026-05-19", hrv: 55 },
    ]);

    const response = await request(createTestApp(makeMockSensorStore()), {
      authorization: "Bearer good-token",
      "x-timezone": "America/Los_Angeles",
      body: createToolCallRequest("render_health_explorer", {
        end_date: "2026-05-19",
        metrics: ["hrv"],
        start_date: "2026-05-18",
        timezone: "Asia/Tokyo",
      }),
    });

    const parsedResponse = z
      .object({
        result: z
          .object({
            structuredContent: z
              .object({
                coverage: z.object({
                  requested_days: z.number(),
                  by_metric: z.record(
                    z.string(),
                    z.object({
                      observed_days: z.number(),
                      missing_days: z.array(z.string()),
                      missing_days_truncated_count: z.number(),
                    }),
                  ),
                }),
                series: z.array(z.object({ metric: z.literal("hrv") }).passthrough()),
              })
              .passthrough(),
          })
          .passthrough(),
      })
      .parse(parseJsonRpcEvent(response.text));

    expect(parsedResponse.result).toMatchObject({
      content: [
        {
          type: "text",
          text: "Dofek Analytics Explorer coverage: hrv 2 of 2 days.",
        },
      ],
      _meta: { ui: { resourceUri: "ui://dofek/health-explorer.html" } },
    });
    expect(healthExplorerSnapshotSchema.parse(parsedResponse.result.structuredContent)).toEqual({
      coverage: {
        requested_days: 2,
        by_metric: {
          hrv: { observed_days: 2, missing_days: [], missing_days_truncated_count: 0 },
        },
      },
      range: {
        end_date: "2026-05-19",
        granularity: "daily",
        start_date: "2026-05-18",
        timezone: "Asia/Tokyo",
      },
      series: [
        {
          label: "Heart rate variability",
          metric: "hrv",
          note: null,
          points: [
            { key: "2026-05-18", value: 50 },
            { key: "2026-05-19", value: 55 },
          ],
          unit: "ms",
        },
      ],
      summary: [{ average: 52.5, max: 55, metric: "hrv", min: 50 }],
    });
  });

  it("returns server-computed baseline context for recovery health trends", async () => {
    authorizeMcpToken();
    const recoveryRow = {
      date: "2026-05-19",
      hrv: 72,
      resting_hr: 48,
      respiratory_rate: 14,
      efficiency_pct: 90,
      hrv_mean_30d: 60,
      hrv_sd_30d: 6,
      hrv_z_score: 2,
      hrv_baseline_sample_count: 24,
      hrv_baseline_coverage: 0.8,
      hrv_mean_7d: 66,
      hrv_mean_previous_28d: 61,
      rhr_mean_30d: 52,
      rhr_sd_30d: 2,
      resting_hr_z_score: -2,
      rhr_baseline_sample_count: 30,
      rhr_baseline_coverage: 1,
      rhr_mean_7d: 49,
      rhr_mean_previous_28d: 53,
      rr_mean_30d: 15,
      rr_sd_30d: 0.5,
      respiratory_rate_z_score: -2,
      rr_baseline_sample_count: 15,
      rr_baseline_coverage: 0.5,
      rr_mean_7d: 14.5,
      rr_mean_previous_28d: 15.2,
      efficiency_mean_30d: 85,
      efficiency_sd_30d: 2.5,
      efficiency_z_score: 2,
      efficiency_baseline_sample_count: 28,
      efficiency_baseline_coverage: 28 / 30,
      efficiency_mean_7d: 88,
      efficiency_mean_previous_28d: 84,
    };
    const sensorStore = makeMockSensorStore([[], [recoveryRow]]);
    toolTestMocks.dailyMetricsListRange.mockResolvedValue([
      { date: "2026-05-19", hrv: 72, resting_hr: 48 },
    ]);

    const response = await request(createTestApp(sensorStore), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("get_health_trends", {
        end_date: "2026-05-19",
        metrics: ["hrv", "resting_hr", "sleep_efficiency"],
        start_date: "2026-05-19",
      }),
    });

    expect(parseToolCallText(response.text)).toMatchObject({
      series: [
        expect.objectContaining({
          metric: "hrv",
          points: [
            expect.objectContaining({
              key: "2026-05-19",
              value: 72,
              baseline_relative: expect.objectContaining({
                baseline: {
                  coverage: 0.8,
                  mean: 60,
                  sampleCount: 24,
                  standardDeviation: 6,
                  windowDays: 30,
                  zScore: 2,
                },
                comparison: expect.objectContaining({
                  delta: 5,
                  direction: "increasing",
                }),
              }),
            }),
          ],
        }),
        expect.objectContaining({
          metric: "resting_hr",
          points: [
            expect.objectContaining({
              baseline_relative: expect.objectContaining({
                baseline: expect.objectContaining({ mean: 52, zScore: -2 }),
              }),
            }),
          ],
        }),
        expect.objectContaining({
          metric: "sleep_efficiency",
          points: [
            expect.objectContaining({
              baseline_relative: expect.objectContaining({
                baseline: expect.objectContaining({ mean: 85, zScore: 2 }),
              }),
            }),
          ],
        }),
      ],
    });
  });

  it("rejects reversed longitudinal date ranges", async () => {
    authorizeMcpToken();

    const response = await request(createTestApp(), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("get_health_trends", {
        end_date: "2026-05-18",
        start_date: "2026-05-19",
      }),
    });

    const parsedResponse = toolCallResponseSchema.parse(parseJsonRpcEvent(response.text));
    expect(parsedResponse.result.isError).toBe(true);
    expect(parsedResponse.result.content[0]?.text).toBe("start_date must be on or before end_date");
  });

  it("fails health trends explicitly when the analytics store is unavailable", async () => {
    authorizeMcpToken();

    const response = await request(createTestApp(), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("get_health_trends", {
        end_date: "2026-05-19",
        start_date: "2026-05-18",
      }),
    });

    const parsedResponse = toolCallResponseSchema.parse(parseJsonRpcEvent(response.text));
    expect(parsedResponse.result.isError).toBe(true);
    expect(parsedResponse.result.content[0]?.text).toBe(
      "get_health_trends requires the ClickHouse analytics store",
    );
  });

  it("returns sleep summaries with stages and local sleep times", async () => {
    authorizeMcpToken();
    toolTestMocks.dailyMetricsListRange.mockResolvedValue([
      { date: "2026-05-18", respiratory_rate_avg: 14.2 },
    ]);
    toolTestMocks.sleepListRange.mockResolvedValue([
      {
        awake_minutes: 30,
        date: "2026-05-18",
        deep_minutes: 80,
        duration_minutes: 420,
        efficiency_pct: 90,
        ended_at: "2026-05-19T14:00:00.000Z",
        timezone: null,
        start_utc_offset_minutes: -420,
        end_utc_offset_minutes: -420,
        local_time_source: "provider_offset",
        light_minutes: 240,
        provider_id: "whoop",
        rem_minutes: 100,
        staging_available: true,
        started_at: "2026-05-19T06:00:00.000Z",
      },
    ]);

    const response = await request(createTestApp(), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("get_sleep_summary", {
        end_date: "2026-05-18",
        start_date: "2026-05-18",
        timezone: "America/Los_Angeles",
      }),
    });

    expect(parseToolCallText(response.text)).toEqual([
      {
        date: "2026-05-18",
        onset_time: "11:00 PM",
        respiratory_rate_avg: 14.2,
        sleep_consistency_pct: null,
        staging_available: true,
        source_provider: "whoop",
        stages: { awake_minutes: 30, light_minutes: 240, rem_minutes: 100, sws_minutes: 80 },
        sleep_efficiency_pct: 90,
        time_in_bed_minutes: 450,
        total_duration_minutes: 420,
        wake_time: "7:00 AM",
        local_time_context: {
          timezone: null,
          startUtcOffsetMinutes: -420,
          endUtcOffsetMinutes: -420,
          source: "provider_offset",
        },
      },
    ]);
  });

  it("returns null clock and duration fields when sleep local-time data is unavailable", async () => {
    authorizeMcpToken();
    toolTestMocks.dailyMetricsListRange.mockResolvedValue([]);
    toolTestMocks.sleepListRange.mockResolvedValue([
      {
        awake_minutes: null,
        date: "2026-05-18",
        deep_minutes: null,
        duration_minutes: null,
        efficiency_pct: null,
        ended_at: null,
        timezone: null,
        start_utc_offset_minutes: null,
        end_utc_offset_minutes: null,
        local_time_source: "unknown",
        light_minutes: null,
        provider_id: "apple_health",
        rem_minutes: null,
        started_at: "2026-05-19T06:00:00.000Z",
      },
    ]);

    const response = await request(createTestApp(), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("get_sleep_summary", {
        end_date: "2026-05-18",
        start_date: "2026-05-18",
        timezone: "America/Los_Angeles",
      }),
    });

    expect(parseToolCallText(response.text)).toEqual([
      expect.objectContaining({
        onset_time: null,
        time_in_bed_minutes: null,
        total_duration_minutes: null,
        wake_time: null,
      }),
    ]);
  });

  it("publishes provenance-checked, modality-stratified power with a three-activity gate", async () => {
    authorizeMcpToken();
    const preGateRows = [
      {
        canonical_type: "cycling",
        avg_hr: 140,
        avg_power: 180,
        ended_at: "2026-05-18T11:00:00.000Z",
        max_hr: 170,
        max_power: 300,
        modality: "indoor",
        started_at: "2026-05-18T10:00:00.000Z",
      },
      {
        canonical_type: "cycling",
        avg_hr: 150,
        avg_power: 190,
        ended_at: "2026-05-19T11:00:00.000Z",
        max_hr: 175,
        max_power: 320,
        modality: "indoor",
        started_at: "2026-05-19T10:00:00.000Z",
      },
      {
        canonical_type: "cycling",
        avg_hr: 155,
        avg_power: 200,
        ended_at: "2026-05-20T11:00:00.000Z",
        max_hr: 178,
        max_power: 310,
        modality: "indoor",
        started_at: "2026-05-20T10:00:00.000Z",
      },
      {
        canonical_type: "cycling",
        avg_hr: 145,
        avg_power: 210,
        ended_at: "2026-05-21T11:00:00.000Z",
        max_hr: 176,
        max_power: 340,
        modality: "outdoor",
        started_at: "2026-05-21T10:00:00.000Z",
      },
      {
        canonical_type: "cycling",
        avg_hr: 148,
        avg_power: 220,
        ended_at: "2026-05-22T11:00:00.000Z",
        max_hr: 177,
        max_power: 350,
        modality: "outdoor",
        started_at: "2026-05-22T10:00:00.000Z",
      },
      {
        canonical_type: "cycling",
        avg_hr: 149,
        avg_power: 230,
        ended_at: "2026-05-23T11:00:00.000Z",
        max_hr: 179,
        max_power: 360,
        modality: null,
        started_at: "2026-05-23T10:00:00.000Z",
      },
      {
        canonical_type: "cycling",
        avg_hr: 147,
        avg_power: 225,
        ended_at: "2026-05-23T10:30:00.000Z",
        max_hr: 175,
        max_power: 355,
        modality: "road",
        started_at: "2026-05-23T09:30:00.000Z",
      },
      {
        canonical_type: "running",
        avg_hr: 160,
        avg_power: 250,
        ended_at: "2026-05-23T12:00:00.000Z",
        max_hr: 180,
        max_power: 380,
        modality: "outdoor",
        started_at: "2026-05-23T11:00:00.000Z",
      },
      {
        canonical_type: "other",
        avg_hr: null,
        avg_power: 260,
        elevation_gain_m: null,
        ended_at: "2026-05-23T13:00:00.000Z",
        max_hr: null,
        max_power: 390,
        modality: null,
        provider_type: "kayaking",
        started_at: "2026-05-23T12:00:00.000Z",
      },
    ];
    toolTestMocks.activityListRange.mockResolvedValue(preGateRows);

    const response = await request(createTestApp(), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("get_activity_summary", {
        end_date: "2026-05-23",
        group_by: "canonical_type_and_week",
        start_date: "2026-05-18",
      }),
    });

    const responseBody = z
      .object({ summaries: z.array(z.record(z.string(), z.unknown())) })
      .parse(parseToolCallText(response.text));
    const summary = responseBody.summaries.find(
      (candidate) => candidate.canonical_type === "cycling",
    );
    expect(summary).toMatchObject({
      canonical_type: "cycling",
      power_by_modality: {
        indoor: {
          activities_total: 3,
          activities_with_power: 3,
          avg_power: 190,
          max_power_peak: 320,
          pct: 100,
        },
        outdoor: {
          activities_total: 2,
          activities_with_power: 2,
          avg_power: null,
          max_power_peak: null,
          pct: 100,
        },
        unknown: {
          activities_total: 2,
          activities_with_power: 2,
          avg_power: null,
          max_power_peak: null,
          pct: 100,
        },
      },
    });
    expect(summary).not.toHaveProperty("avg_power");
    expect(summary).not.toHaveProperty("max_power_peak");
    expect(summary).not.toHaveProperty("power_coverage");
    expect(
      responseBody.summaries.find((candidate) => candidate.canonical_type === "running"),
    ).toMatchObject({
      power_by_modality: {
        outdoor: {
          activities_total: 1,
          activities_with_power: 1,
          avg_power: null,
          max_power_peak: null,
          pct: 100,
        },
      },
    });
    const kayakingSummary = responseBody.summaries.find(
      (candidate) => candidate.canonical_type === "other",
    );
    expect(kayakingSummary).toMatchObject({
      total_elevation_gain_m: null,
      power_by_modality: {
        unknown: {
          activities_total: 1,
          activities_with_power: 1,
          avg_power: null,
          max_power_peak: null,
          pct: 100,
        },
      },
    });
  });

  it("separates activity summaries by modality and reports power and elevation coverage", async () => {
    authorizeMcpToken();
    toolTestMocks.activityListRange.mockResolvedValue([
      {
        canonical_type: "cycling",
        avg_hr: 138,
        avg_power: null,
        elevation_gain_m: 736,
        ended_at: "2026-08-30T11:00:00.000Z",
        max_hr: 170,
        max_power: null,
        modality: "outdoor",
        started_at: "2026-08-30T10:00:00.000Z",
      },
      {
        canonical_type: "cycling",
        avg_hr: 145,
        avg_power: 142,
        elevation_gain_m: 0,
        ended_at: "2026-08-31T11:00:00.000Z",
        max_hr: 175,
        max_power: 260,
        modality: "indoor",
        started_at: "2026-08-31T10:00:00.000Z",
      },
    ]);

    const response = await request(createTestApp(), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("get_activity_summary", {
        end_date: "2026-08-31",
        group_by: "canonical_type_and_modality",
        start_date: "2026-08-30",
      }),
    });

    expect(parseToolCallText(response.text)).toEqual({
      unclassified_pct: 0,
      summaries: [
        expect.objectContaining({
          canonical_type: "cycling",
          modality: "indoor",
          power_by_modality: expect.objectContaining({
            indoor: {
              activities_total: 1,
              activities_with_power: 1,
              avg_power: null,
              max_power_peak: null,
              pct: 100,
            },
          }),
          total_elevation_gain_m: 0,
          avg_elevation_gain_m: 0,
        }),
        expect.objectContaining({
          canonical_type: "cycling",
          modality: "outdoor",
          power_by_modality: expect.objectContaining({
            outdoor: {
              activities_total: 1,
              activities_with_power: 0,
              avg_power: null,
              max_power_peak: null,
              pct: 0,
            },
          }),
          total_elevation_gain_m: 736,
          avg_elevation_gain_m: 736,
        }),
      ],
    });
  });

  it("separates commute cycling from training cycling by purpose", async () => {
    authorizeMcpToken();
    toolTestMocks.activityListRange.mockResolvedValue([
      {
        canonical_type: "cycling",
        avg_hr: 114,
        avg_power: null,
        elevation_gain_m: null,
        ended_at: "2026-08-30T10:22:00.000Z",
        max_hr: 130,
        max_power: null,
        modality: "outdoor",
        provider_type: "commuting",
        started_at: "2026-08-30T10:00:00.000Z",
      },
      {
        canonical_type: "cycling",
        avg_hr: 114,
        avg_power: null,
        elevation_gain_m: null,
        ended_at: "2026-08-30T09:22:00.000Z",
        max_hr: 130,
        max_power: null,
        modality: "outdoor",
        provider_type: "89",
        started_at: "2026-08-30T09:00:00.000Z",
      },
      {
        canonical_type: "cycling",
        avg_hr: 136,
        avg_power: 180,
        elevation_gain_m: 310,
        ended_at: "2026-08-31T11:02:00.000Z",
        max_hr: 168,
        max_power: 280,
        modality: "outdoor",
        provider_type: "cycling",
        started_at: "2026-08-31T10:00:00.000Z",
      },
      {
        canonical_type: "running",
        avg_hr: 150,
        avg_power: null,
        elevation_gain_m: null,
        ended_at: "2026-08-31T12:30:00.000Z",
        max_hr: 172,
        max_power: null,
        modality: "outdoor",
        provider_type: "running",
        started_at: "2026-08-31T12:00:00.000Z",
      },
    ]);

    const response = await request(createTestApp(), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("get_activity_summary", {
        end_date: "2026-08-31",
        group_by: "canonical_type_and_purpose",
        start_date: "2026-08-30",
      }),
    });

    expect(parseToolCallText(response.text)).toEqual({
      unclassified_pct: 0,
      summaries: [
        expect.objectContaining({
          canonical_type: "cycling",
          purpose: "commute",
          count: 2,
          avg_duration_minutes: 22,
          avg_hr: 114,
        }),
        expect.objectContaining({
          canonical_type: "cycling",
          purpose: "training",
          count: 1,
          avg_duration_minutes: 62,
          avg_hr: 136,
        }),
        expect.objectContaining({
          canonical_type: "running",
          purpose: null,
          count: 1,
        }),
      ],
    });
  });

  it("reports the percentage of activities that remain unclassified", async () => {
    authorizeMcpToken();
    toolTestMocks.activityListRange.mockResolvedValue([
      ...Array.from({ length: 9 }, (_, index) => ({
        canonical_type: "cycling",
        provider_type: "cycling",
        avg_hr: 136,
        avg_power: null,
        elevation_gain_m: null,
        ended_at: `2026-08-${String(index + 2).padStart(2, "0")}T11:00:00.000Z`,
        max_hr: 160,
        max_power: null,
        started_at: `2026-08-${String(index + 2).padStart(2, "0")}T10:00:00.000Z`,
      })),
      {
        canonical_type: "other",
        provider_type: "",
        avg_hr: 114,
        avg_power: null,
        elevation_gain_m: null,
        ended_at: "2026-08-21T11:00:00.000Z",
        max_hr: 130,
        max_power: null,
        started_at: "2026-08-21T10:00:00.000Z",
      },
    ]);

    const response = await request(createTestApp(), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("get_activity_summary", {
        end_date: "2026-08-21",
        start_date: "2026-08-02",
      }),
    });

    expect(parseToolCallText(response.text)).toMatchObject({
      unclassified_pct: 10,
      summaries: expect.arrayContaining([
        expect.objectContaining({ canonical_type: "cycling", count: 9 }),
        expect.objectContaining({ canonical_type: "other", count: 1 }),
      ]),
    });
  });

  it("supports activity-type and week grouping with missing measurements", async () => {
    authorizeMcpToken();
    toolTestMocks.activityListRange.mockResolvedValue([
      {
        canonical_type: "running",
        avg_hr: null,
        avg_power: null,
        ended_at: null,
        max_hr: null,
        max_power: null,
        started_at: "2026-05-18T10:00:00.000Z",
      },
    ]);

    const activityTypeResponse = await request(createTestApp(), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("get_activity_summary", {
        end_date: "2026-05-18",
        start_date: "2026-05-18",
      }),
    });
    expect(parseToolCallText(activityTypeResponse.text)).toEqual({
      unclassified_pct: 0,
      summaries: [
        {
          canonical_type: "running",
          avg_duration_minutes: null,
          avg_hr: null,
          count: 1,
          max_hr_peak: null,
          power_by_modality: {
            indoor: {
              activities_total: 0,
              activities_with_power: 0,
              avg_power: null,
              max_power_peak: null,
              pct: 0,
            },
            outdoor: {
              activities_total: 0,
              activities_with_power: 0,
              avg_power: null,
              max_power_peak: null,
              pct: 0,
            },
            unknown: {
              activities_total: 1,
              activities_with_power: 0,
              avg_power: null,
              max_power_peak: null,
              pct: 0,
            },
          },
          total_elevation_gain_m: null,
          avg_elevation_gain_m: null,
          total_duration_minutes: 0,
        },
      ],
    });

    const weekResponse = await request(createTestApp(), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("get_activity_summary", {
        end_date: "2026-05-18",
        group_by: "week",
        start_date: "2026-05-18",
      }),
    });
    expect(parseToolCallText(weekResponse.text)).toEqual({
      unclassified_pct: 0,
      summaries: [expect.objectContaining({ week: "2026-W21" })],
    });
  });

  it("returns daily nutrition totals using the nutrition read scope", async () => {
    authorizeMcpToken(["nutrition:read"]);
    toolTestMocks.foodDailyTotalsRange.mockResolvedValue([
      {
        calories: 2_450,
        carbsGrams: 280,
        date: "2026-05-18",
        fatGrams: 85,
        fiberGrams: 32,
        mealCount: 4,
        proteinGrams: 165,
        sourceProviders: ["fatsecret"],
        resolutionStatus: "available",
        resolutionMessage: "Totals use the only available nutrition source.",
        contributingProviders: ["fatsecret"],
        excludedProviders: [],
      },
    ]);

    const response = await request(createTestApp(), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("get_nutrition_summary", {
        end_date: "2026-05-18",
        start_date: "2026-05-18",
      }),
    });

    expect(parseToolCallText(response.text)).toEqual([
      {
        carbs_g: 280,
        date: "2026-05-18",
        fat_g: 85,
        fiber_g: 32,
        meal_count: 4,
        protein_g: 165,
        resolution_message: "Totals use the only available nutrition source.",
        resolution_status: "available",
        source_provider: "fatsecret",
        source_providers: ["fatsecret"],
        contributing_providers: ["fatsecret"],
        excluded_providers: [],
        total_calories: 2_450,
      },
    ]);
  });

  it("reports an explicit conflict instead of totals when a day combines sources", async () => {
    authorizeMcpToken(["nutrition:read"]);
    toolTestMocks.foodDailyTotalsRange.mockResolvedValue([
      {
        calories: null,
        carbsGrams: null,
        date: "2026-05-18",
        fatGrams: null,
        fiberGrams: null,
        mealCount: 4,
        proteinGrams: null,
        sourceProviders: ["cronometer", "fatsecret"],
        resolutionStatus: "source_conflict",
        resolutionMessage: "Totals are unavailable because nutrition sources overlap.",
        contributingProviders: [],
        excludedProviders: ["cronometer", "fatsecret"],
      },
    ]);

    const response = await request(createTestApp(), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("get_nutrition_summary", {
        end_date: "2026-05-18",
        start_date: "2026-05-18",
        timezone: "America/Los_Angeles",
      }),
    });

    expect(parseToolCallText(response.text)).toEqual([
      expect.objectContaining({
        resolution_status: "source_conflict",
        total_calories: null,
        source_provider: null,
        source_providers: ["cronometer", "fatsecret"],
        contributing_providers: [],
        excluded_providers: ["cronometer", "fatsecret"],
      }),
    ]);
  });

  it("returns body metrics and computes lean mass on the server", async () => {
    authorizeMcpToken();
    toolTestMocks.bodyListReconciledRange.mockResolvedValue([
      {
        date: "2026-05-18",
        weightKg: 80,
        bodyFatPct: 20,
        leanMassKg: 64,
        bmi: 24.5,
        sourceProviderByMetric: {
          weightKg: "withings",
          bodyFatPct: "withings",
          bmi: "withings",
        },
        sources: [
          {
            sourceProvider: "withings",
            recordedAt: "2026-05-18T08:00:00.000Z",
            weightKg: 80,
            bodyFatPct: 20,
            bmi: 24.5,
          },
        ],
        coverage: { sourceCount: 1 },
      },
    ]);

    const response = await request(createTestApp(makeMockSensorStore()), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("get_body_metrics", {
        end_date: "2026-05-18",
        start_date: "2026-05-18",
      }),
    });

    expect(parseToolCallText(response.text)).toEqual([
      {
        bmi: 24.5,
        body_fat_pct: 20,
        date: "2026-05-18",
        lean_mass_kg: 64,
        source_provider_by_metric: {
          weight_kg: "withings",
          body_fat_pct: "withings",
          bmi: "withings",
        },
        sources: [
          {
            source_provider: "withings",
            recorded_at: "2026-05-18T08:00:00.000Z",
            weight_kg: 80,
            body_fat_pct: 20,
            bmi: 24.5,
          },
        ],
        coverage: { source_count: 1 },
        weight_kg: 80,
      },
    ]);
  });

  it("requires the body analytics store and preserves unavailable composition", async () => {
    authorizeMcpToken();
    const missingStoreResponse = await request(createTestApp(), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("get_body_metrics", {
        end_date: "2026-05-18",
        start_date: "2026-05-18",
      }),
    });
    const parsedError = toolCallResponseSchema.parse(parseJsonRpcEvent(missingStoreResponse.text));
    expect(parsedError.result.isError).toBe(true);
    expect(parsedError.result.content[0]?.text).toBe(
      "get_body_metrics requires the ClickHouse analytics store",
    );

    toolTestMocks.bodyListReconciledRange.mockResolvedValue([
      {
        date: "2026-05-18",
        weightKg: 80,
        bmi: null,
        bodyFatPct: null,
        leanMassKg: null,
        sourceProviderByMetric: {
          weightKg: "withings",
          bodyFatPct: null,
          bmi: null,
        },
        sources: [],
        coverage: { sourceCount: 1 },
      },
    ]);
    const response = await request(createTestApp(makeMockSensorStore()), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("get_body_metrics", {
        end_date: "2026-05-18",
        start_date: "2026-05-18",
      }),
    });
    expect(parseToolCallText(response.text)).toEqual([
      expect.objectContaining({ body_fat_pct: null, lean_mass_kg: null, weight_kg: 80 }),
    ]);
  });

  it("returns unfiltered activities when no search query is provided", async () => {
    authorizeMcpToken();
    toolTestMocks.activitySearch.mockResolvedValue({
      items: [
        { canonical_type: "cycling", name: "Morning Ride" },
        { canonical_type: "swim", name: "Pool" },
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
        { canonical_type: "cycling", name: "Morning Ride" },
        { canonical_type: "swim", name: "Pool" },
      ],
      totalCount: 2,
    });
  });

  it("matches activity searches against activity names", async () => {
    authorizeMcpToken();
    toolTestMocks.activitySearch.mockResolvedValue({
      items: [{ canonical_type: "cycling", name: "Morning Ride" }],
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
      items: [{ canonical_type: "cycling", name: "Morning Ride" }],
      totalCount: 2,
    });
  });

  it("returns an activity with its strength, climbing, and finger-loading details", async () => {
    authorizeMcpToken();
    const activityId = "00000000-0000-4000-8000-000000000001";
    toolTestMocks.activityFindById.mockResolvedValue({ id: activityId, name: "Training" });
    toolTestMocks.strengthExercises.mockResolvedValue([
      { toDetail: () => ({ exerciseName: "Pull-up", muscleGroups: ["back"] }) },
    ]);
    toolTestMocks.climbingActivityEntries.mockResolvedValue([
      { toDetail: () => ({ grade: "V5", routeName: "Blue Circuit" }) },
    ]);
    toolTestMocks.fingerLoadingActivity.mockResolvedValue([
      { exercise: "max_hang", effectiveLoadKg: 95 },
    ]);

    const response = await request(createTestApp(), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("get_activity_details", { activity_id: activityId }),
    });

    expect(parseToolCallText(response.text)).toEqual({
      activity: { id: activityId, name: "Training" },
      climbing_entries: [{ grade: "V5", routeName: "Blue Circuit" }],
      finger_loading: [{ exercise: "max_hang", effectiveLoadKg: 95 }],
      strength_exercises: [{ exerciseName: "Pull-up", muscleGroups: ["back"] }],
    });
    expect(toolTestMocks.activityFindById).toHaveBeenCalledWith(activityId);
  });

  it("returns the authenticated user's supplement definitions", async () => {
    authorizeMcpToken();
    toolTestMocks.supplementsList.mockResolvedValue([
      { amount: 5, id: "creatine", name: "Creatine", unit: "g" },
    ]);

    const response = await request(createTestApp(), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("get_supplements", {}),
    });

    expect(parseToolCallText(response.text)).toEqual([
      { amount: 5, id: "creatine", name: "Creatine", unit: "g" },
    ]);
  });

  it("returns a capped, channel-filtered activity stream", async () => {
    authorizeMcpToken();
    const activityId = "00000000-0000-4000-8000-000000000001";
    toolTestMocks.activityGetStream.mockResolvedValue([
      {
        toDetail: () => ({
          altitude: 30,
          cadence: 90,
          heartRate: 145,
          lat: 37.8,
          lng: -122.4,
          power: 250,
          recordedAt: "2026-08-30T10:00:00.000Z",
          speed: 8.5,
        }),
      },
    ]);

    const response = await request(createTestApp(makeMockSensorStore()), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("get_activity_streams", {
        activity_id: activityId,
        channels: ["heart_rate", "position", "power"],
        downsample_to: 750,
      }),
    });

    expect(parseToolCallText(response.text)).toEqual({
      channels: ["heart_rate", "position", "power"],
      points: [
        {
          heart_rate: 145,
          latitude: 37.8,
          longitude: -122.4,
          power: 250,
          recorded_at: "2026-08-30T10:00:00.000Z",
        },
      ],
    });
    expect(toolTestMocks.activityGetStream).toHaveBeenCalledWith(activityId, 750);
  });

  it("returns every stream channel with the default downsample cap", async () => {
    authorizeMcpToken();
    const activityId = "00000000-0000-4000-8000-000000000002";
    toolTestMocks.activityGetStream.mockResolvedValue([
      {
        toDetail: () => ({
          altitude: 30,
          cadence: 90,
          heartRate: 145,
          lat: 37.8,
          lng: -122.4,
          power: 250,
          recordedAt: "2026-08-30T10:00:00.000Z",
          speed: 8.5,
        }),
      },
    ]);

    const response = await request(createTestApp(makeMockSensorStore()), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("get_activity_streams", { activity_id: activityId }),
    });

    expect(parseToolCallText(response.text)).toEqual({
      channels: ["power", "heart_rate", "cadence", "altitude", "speed", "position"],
      points: [
        {
          altitude: 30,
          cadence: 90,
          heart_rate: 145,
          latitude: 37.8,
          longitude: -122.4,
          power: 250,
          recorded_at: "2026-08-30T10:00:00.000Z",
          speed: 8.5,
        },
      ],
    });
    expect(toolTestMocks.activityGetStream).toHaveBeenCalledWith(activityId, 500);
  });

  it("omits every unselected stream channel", async () => {
    authorizeMcpToken();
    const activityId = "00000000-0000-4000-8000-000000000003";
    toolTestMocks.activityGetStream.mockResolvedValue([
      {
        toDetail: () => ({
          altitude: 30,
          cadence: 90,
          heartRate: 145,
          lat: 37.8,
          lng: -122.4,
          power: 250,
          recordedAt: "2026-08-30T10:00:00.000Z",
          speed: 8.5,
        }),
      },
    ]);

    const response = await request(createTestApp(makeMockSensorStore()), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("get_activity_streams", {
        activity_id: activityId,
        channels: ["cadence"],
      }),
    });

    expect(parseToolCallText(response.text)).toEqual({
      channels: ["cadence"],
      points: [{ cadence: 90, recorded_at: "2026-08-30T10:00:00.000Z" }],
    });
  });

  it("requires the analytics store for activity streams", async () => {
    authorizeMcpToken();
    const response = await request(createTestApp(), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("get_activity_streams", {
        activity_id: "00000000-0000-4000-8000-000000000004",
      }),
    });

    const parsedResponse = toolCallResponseSchema.parse(parseJsonRpcEvent(response.text));
    expect(parsedResponse.result.isError).toBe(true);
    expect(parsedResponse.result.content[0]?.text).toBe(
      "get_activity_streams requires the ClickHouse analytics store",
    );
  });

  it("lists configured providers with connection and reauth state", async () => {
    authorizeMcpToken();
    toolTestMocks.getConnectedProviderIds.mockResolvedValue([
      { providerId: "fitbit", updatedAt: new Date("2026-05-20T11:00:00.000Z") },
      { providerId: "wahoo", updatedAt: new Date("2026-05-20T11:00:00.000Z") },
    ]);
    toolTestMocks.getLastSyncTimes.mockResolvedValue([
      { lastSynced: "2026-05-20T12:00:00.000Z", providerId: "wahoo" },
    ]);
    toolTestMocks.getScheduledSyncHealth.mockResolvedValue([
      {
        providerId: "wahoo",
        lastSuccess: "2026-05-20T11:00:00.000Z",
        lastAttempt: "2026-05-20T12:00:00.000Z",
        lastError: "Wahoo access token expired.",
        consecutiveFailures: 2,
      },
    ]);
    toolTestMocks.getLatestErrors.mockResolvedValue([
      {
        authFailureReason: null,
        errorMessage: "rate limit exceeded",
        providerId: "fitbit",
        syncedAt: new Date("2026-05-20T12:00:00.000Z"),
      },
      {
        authFailureReason: null,
        errorMessage: "token expired",
        providerId: "strava",
        syncedAt: new Date("2026-05-20T12:00:00.000Z"),
      },
      {
        authFailureReason: "access_token_expired",
        errorMessage: "Wahoo access token expired.",
        providerId: "wahoo",
        syncedAt: new Date("2026-05-20T12:00:00.000Z"),
      },
    ]);
    toolTestMocks.getAllProviders.mockReturnValue([
      {
        authSetup: () => ({ oauthConfig: {}, exchangeCode: async () => ({}) }),
        id: "fitbit",
        name: "Fitbit",
        validate: () => null,
      },
      {
        authSetup: () => ({ oauthConfig: {}, exchangeCode: async () => ({}) }),
        id: "strava",
        name: "Strava",
        validate: () => null,
      },
      {
        authSetup: () => ({ oauthConfig: {}, exchangeCode: async () => ({}) }),
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
        sync_health: {
          consecutive_failures: 0,
          expected_sync_interval_minutes: 30,
          last_attempt: null,
          last_error: null,
          last_success: null,
          stale: true,
        },
      },
      {
        authType: "oauth",
        authorized: false,
        id: "strava",
        importOnly: false,
        lastSyncedAt: null,
        name: "Strava",
        needsReauth: false,
        sync_health: null,
      },
      {
        authType: "oauth",
        authorized: true,
        id: "wahoo",
        importOnly: false,
        lastSyncedAt: "2026-05-20T12:00:00.000Z",
        name: "Wahoo",
        needsReauth: true,
        sync_health: {
          consecutive_failures: 2,
          expected_sync_interval_minutes: 30,
          last_attempt: "2026-05-20T12:00:00.000Z",
          last_error: "Wahoo access token expired.",
          last_success: "2026-05-20T11:00:00.000Z",
          stale: true,
        },
      },
    ]);
  });

  it("clears MCP provider reauth state when tokens were updated after the latest auth error", async () => {
    authorizeMcpToken();
    toolTestMocks.getConnectedProviderIds.mockResolvedValue([
      { providerId: "wahoo", updatedAt: new Date("2026-05-20T12:05:00.000Z") },
    ]);
    toolTestMocks.getLastSyncTimes.mockResolvedValue([
      { lastSynced: "2026-05-20T12:00:00.000Z", providerId: "wahoo" },
    ]);
    toolTestMocks.getLatestErrors.mockResolvedValue([
      {
        authFailureReason: "access_token_expired",
        errorMessage: "Wahoo access token expired.",
        providerId: "wahoo",
        syncedAt: new Date("2026-05-20T12:00:00.000Z"),
      },
    ]);
    toolTestMocks.getAllProviders.mockReturnValue([
      {
        authSetup: () => ({ oauthConfig: {}, exchangeCode: async () => ({}) }),
        id: "wahoo",
        name: "Wahoo",
        validate: () => null,
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
        id: "wahoo",
        importOnly: false,
        lastSyncedAt: "2026-05-20T12:00:00.000Z",
        name: "Wahoo",
        needsReauth: false,
        sync_health: {
          consecutive_failures: 0,
          expected_sync_interval_minutes: 30,
          last_attempt: null,
          last_error: null,
          last_success: null,
          stale: true,
        },
      },
    ]);
  });

  it("enqueues provider sync jobs for configured providers", async () => {
    authorizeMcpToken();
    const enqueueSpy = vi.spyOn(enqueueSyncJobModule, "enqueueSyncJob");
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

    expect(enqueueSpy).toHaveBeenCalledWith(
      "wahoo",
      expect.objectContaining({
        providerId: "wahoo",
        sinceDays: 7,
        userId: "user-id",
      }),
      { skipWhenRateLimited: true },
    );
    expect(toolTestMocks.withUserWriteFence).toHaveBeenCalledWith(
      expect.anything(),
      "user-id",
      expect.any(Function),
    );
    expect(toolTestMocks.getProviderSyncQueue).toHaveBeenCalledWith("wahoo");
    expect(toolTestMocks.queueAdd).toHaveBeenCalledWith(
      "sync",
      {
        origin: "manual",
        providerId: "wahoo",
        sinceDays: 7,
        sinceIso: expect.any(String),
        targetRefreshWindow: { days: 7, type: "days" },
        untilIso: expect.any(String),
        userId: "user-id",
      },
      expect.objectContaining({ attempts: expect.any(Number) }),
    );
    expect(parseToolCallText(response.text)).toEqual({
      jobId: "wahoo:job-123",
      providerId: "wahoo",
      queueName: "sync-wahoo",
      status: "queued",
    });
  });

  it("rejects provider sync dispatch before queueing when account erasure is active", async () => {
    authorizeMcpToken();
    toolTestMocks.getAllProviders.mockReturnValue([
      { id: "wahoo", name: "Wahoo", validate: () => null },
    ]);
    toolTestMocks.withUserWriteFence.mockRejectedValueOnce(new Error("Account erasure is active"));

    const response = await request(createTestApp(), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("start_provider_sync", {
        providerId: "wahoo",
        sinceDays: 7,
      }),
    });

    const parsedResponse = toolCallResponseSchema.parse(parseJsonRpcEvent(response.text));
    expect(parsedResponse.result.isError).toBe(true);
    expect(parsedResponse.result.content[0]?.text).toBe("Account erasure is active");
    expect(toolTestMocks.queueAdd).not.toHaveBeenCalled();
  });

  it("returns a tool error when sync enqueue is skipped for rate-limit cooldown", async () => {
    authorizeMcpToken();
    vi.spyOn(enqueueSyncJobModule, "enqueueSyncJob").mockResolvedValueOnce(null);
    toolTestMocks.getAllProviders.mockReturnValue([
      { id: "wahoo", name: "Wahoo", validate: () => null },
    ]);

    const response = await request(createTestApp(), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("start_provider_sync", {
        providerId: "wahoo",
        sinceDays: 7,
      }),
    });

    const parsedResponse = toolCallResponseSchema.parse(parseJsonRpcEvent(response.text));
    expect(parsedResponse.result.isError).toBe(true);
    expect(parsedResponse.result.content[0]?.text).toBe(
      "Provider wahoo sync skipped: rate-limit cooldown active",
    );
    expect(toolTestMocks.queueAdd).not.toHaveBeenCalled();
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

  it("returns tool errors for incomplete date ranges", async () => {
    authorizeMcpToken();
    toolTestMocks.getAllProviders.mockReturnValue([
      { id: "wahoo", name: "Wahoo", validate: () => null },
    ]);

    const response = await request(createTestApp(), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("start_provider_sync", {
        providerId: "wahoo",
        sinceDate: "2026-06-01",
      }),
    });

    const parsedResponse = toolCallResponseSchema.parse(parseJsonRpcEvent(response.text));
    expect(parsedResponse.result.isError).toBe(true);
    expect(parsedResponse.result.content[0]?.text).toBe(
      "sinceDate and untilDate must be provided together",
    );
  });

  it("returns tool errors when sinceDays is combined with explicit dates", async () => {
    authorizeMcpToken();
    toolTestMocks.getAllProviders.mockReturnValue([
      { id: "wahoo", name: "Wahoo", validate: () => null },
    ]);

    const response = await request(createTestApp(), {
      authorization: "Bearer good-token",
      body: createToolCallRequest("start_provider_sync", {
        providerId: "wahoo",
        sinceDays: 7,
        sinceDate: "2026-06-01",
        untilDate: "2026-06-07",
      }),
    });

    const parsedResponse = toolCallResponseSchema.parse(parseJsonRpcEvent(response.text));
    expect(parsedResponse.result.isError).toBe(true);
    expect(parsedResponse.result.content[0]?.text).toBe(
      "sinceDays cannot be combined with sinceDate/untilDate",
    );
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
