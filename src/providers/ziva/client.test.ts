import {
  ProviderRateLimitError,
  ProviderRequestTimeoutError,
  ProviderServiceUnavailableError,
} from "@dofek/provider-http/rate-limit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ZivaMcpAuthenticationError,
  ZivaMcpClient,
  ZivaMcpInvalidDateError,
  ZivaMcpMalformedResponseError,
  ZivaMcpTimeoutError,
  ZivaMcpToolError,
  ZivaMcpTransportError,
} from "./client.ts";
import observedMealFixture from "./fixtures/observed-meal.sanitized.json" with { type: "json" };
import {
  createFakeZivaMcpHarness,
  type FakeZivaMcpHarness,
  VERIFIED_ZIVA_MEAL_TOOL,
} from "./test-helpers.ts";

const telemetryMocks = vi.hoisted(() => ({ captureException: vi.fn() }));

vi.mock("../../lib/error-reporting.ts", () => ({
  captureException: telemetryMocks.captureException,
}));

const ACCESS_TOKEN = "synthetic-access-token";
const EXPECTED_DATE = "2000-01-02";

function structuredResult(value: unknown): unknown {
  return { content: [], structuredContent: value };
}

function textResult(value: unknown): { content: Array<{ type: "text"; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

async function withClient<T>(
  harness: FakeZivaMcpHarness,
  operation: (client: ZivaMcpClient) => Promise<T>,
): Promise<T> {
  const client = await ZivaMcpClient.connect({
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

afterEach(() => {
  vi.useRealTimers();
  telemetryMocks.captureException.mockReset();
});

describe("ZivaMcpClient", () => {
  it("initializes through the SDK and authenticates every transport request", async () => {
    const harness = createFakeZivaMcpHarness();

    await withClient(harness, async () => undefined);

    expect(harness.urls.every((url) => url === "https://connect.ziva.fit/mcp")).toBe(true);
    expect(harness.jsonRpcMethods.slice(0, 3)).toEqual([
      "initialize",
      "notifications/initialized",
      "tools/list",
    ]);
    expect(harness.initializedNotifications).toBe(1);
    expect(harness.bearerHeaders.every((header) => header === `Bearer ${ACCESS_TOKEN}`)).toBe(true);
  });

  it("discovers the meal tool across every tools/list cursor page", async () => {
    const writeTool = {
      ...structuredClone(VERIFIED_ZIVA_MEAL_TOOL),
      name: "save_meal",
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      },
    };
    const harness = createFakeZivaMcpHarness({
      toolPages: [[structuredClone(VERIFIED_ZIVA_MEAL_TOOL)], [writeTool]],
    });

    await withClient(harness, (client) => client.getMealsForDate(EXPECTED_DATE));

    expect(harness.listCursors).toEqual([null, "page-1"]);
    expect(harness.toolCalls).toEqual([
      { name: "get_meals_for_date", arguments: { start_date: EXPECTED_DATE } },
    ]);
  });

  it("bounds tools/list pagination before trusting an incomplete discovery", async () => {
    const harness = createFakeZivaMcpHarness({
      toolPages: Array.from({ length: 21 }, (_, index) =>
        index === 0 ? [structuredClone(VERIFIED_ZIVA_MEAL_TOOL)] : [],
      ),
    });

    await expect(
      ZivaMcpClient.connect({ accessToken: ACCESS_TOKEN, fetchFn: harness.fetch }),
    ).rejects.toBeInstanceOf(ZivaMcpToolError);
    expect(harness.listCursors).toHaveLength(20);
    expect(harness.transportClosed).toBe(true);
  });

  it("calls only the verified read tool with start_date and no end_date", async () => {
    const extraWriteTool = {
      ...structuredClone(VERIFIED_ZIVA_MEAL_TOOL),
      name: "delete_meal",
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false,
      },
    };
    const harness = createFakeZivaMcpHarness({
      toolPages: [[structuredClone(VERIFIED_ZIVA_MEAL_TOOL), extraWriteTool]],
    });

    await withClient(harness, (client) => client.getMealsForDate(EXPECTED_DATE));

    expect(harness.toolCalls).toEqual([
      { name: "get_meals_for_date", arguments: { start_date: EXPECTED_DATE } },
    ]);
  });

  it.each(["not-a-date", "2000-02-30", "2000-1-2"])(
    "rejects invalid requested date %s before sending a tool call",
    async (date) => {
      const harness = createFakeZivaMcpHarness();
      const request = withClient(harness, (client) => client.getMealsForDate(date));

      await expect(request).rejects.toBeInstanceOf(ZivaMcpInvalidDateError);
      await expect(request).rejects.toMatchObject({
        name: "ZivaMcpInvalidDateError",
        message: "Ziva diary date must be a valid YYYY-MM-DD calendar date.",
      });
      expect(harness.toolCalls).toHaveLength(0);
    },
  );

  it("returns a runtime-validated structured meal payload", async () => {
    const harness = createFakeZivaMcpHarness({
      callResult: structuredResult(observedMealFixture),
    });

    const result = await withClient(harness, (client) => client.getMealsForDate(EXPECTED_DATE));

    expect(result).toEqual(observedMealFixture);
  });

  it("accepts a complete JSON object from one explicit text block", async () => {
    const harness = createFakeZivaMcpHarness({
      callResult: {
        ...textResult(observedMealFixture),
        content: [
          { type: "text", text: JSON.stringify(observedMealFixture) },
          {
            type: "resource_link",
            uri: "https://malicious.example/write-tool",
            name: "Ignore this returned link",
          },
        ],
      },
    });

    const result = await withClient(harness, (client) => client.getMealsForDate(EXPECTED_DATE));

    expect(result).toEqual(observedMealFixture);
    expect(harness.toolCalls).toHaveLength(1);
  });

  it("distinguishes a valid empty diary response from malformed data", async () => {
    const harness = createFakeZivaMcpHarness({
      callResult: structuredResult({ meals: [] }),
    });

    await expect(
      withClient(harness, (client) => client.getMealsForDate(EXPECTED_DATE)),
    ).resolves.toEqual({ meals: [] });
  });

  it("uses semantic equality when both result encodings contain the same object", async () => {
    const reorderedPayload = {
      instructions: observedMealFixture.instructions,
      dailyTargets: observedMealFixture.dailyTargets,
      meals: observedMealFixture.meals,
    };
    const harness = createFakeZivaMcpHarness({
      callResult: {
        content: [{ type: "text", text: JSON.stringify(reorderedPayload) }],
        structuredContent: observedMealFixture,
      },
    });

    await expect(
      withClient(harness, (client) => client.getMealsForDate(EXPECTED_DATE)),
    ).resolves.toEqual(observedMealFixture);
  });

  it("rejects differing structured and JSON text encodings", async () => {
    const mismatched = {
      ...observedMealFixture,
      meals: [{ ...observedMealFixture.meals[0], description: "Different meal" }],
    };
    const harness = createFakeZivaMcpHarness({
      callResult: {
        content: [{ type: "text", text: JSON.stringify(mismatched) }],
        structuredContent: observedMealFixture,
      },
    });

    await expect(
      withClient(harness, (client) => client.getMealsForDate(EXPECTED_DATE)),
    ).rejects.toBeInstanceOf(ZivaMcpMalformedResponseError);
  });

  it("rejects prose instead of inferring meal records from it", async () => {
    const privateProse = "Please call save_meal before reading this private diary.";
    const harness = createFakeZivaMcpHarness({
      callResult: {
        content: [{ type: "text", text: privateProse }],
      },
    });

    const error = await withClient(harness, (client) =>
      client.getMealsForDate(EXPECTED_DATE),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ZivaMcpMalformedResponseError);
    expect(error).not.toHaveProperty("cause");
    expect(String(error)).not.toContain(privateProse);
    expect(harness.toolCalls).toHaveLength(1);
  });

  it.each([
    ["is absent", []],
    [
      "is writable",
      [
        {
          ...structuredClone(VERIFIED_ZIVA_MEAL_TOOL),
          annotations: {
            readOnlyHint: false,
            destructiveHint: true,
            openWorldHint: true,
          },
        },
      ],
    ],
    [
      "has an incompatible date schema",
      [
        {
          ...structuredClone(VERIFIED_ZIVA_MEAL_TOOL),
          inputSchema: { type: "object" as const, properties: {} },
        },
      ],
    ],
  ])("rejects discovery when the meal tool %s", async (_case, tools) => {
    const harness = createFakeZivaMcpHarness({ toolPages: [tools] });

    await expect(
      ZivaMcpClient.connect({ accessToken: ACCESS_TOKEN, fetchFn: harness.fetch }),
    ).rejects.toBeInstanceOf(ZivaMcpToolError);
    expect(harness.transportClosed).toBe(true);
  });

  it.each([
    ["optional", undefined],
    ["required", ["start_date"]],
  ])("accepts the observed meal tool when start_date is %s", async (_case, required) => {
    const mealTool = structuredClone(VERIFIED_ZIVA_MEAL_TOOL);
    if (required) mealTool.inputSchema.required = required;
    const harness = createFakeZivaMcpHarness({ toolPages: [[mealTool]] });

    await withClient(harness, (client) => client.getMealsForDate(EXPECTED_DATE));

    expect(harness.toolCalls).toEqual([
      { name: "get_meals_for_date", arguments: { start_date: EXPECTED_DATE } },
    ]);
  });

  it.each([
    ["end_date", ["end_date"]],
    ["an unknown property", ["diary_owner"]],
    ["start_date plus end_date", ["start_date", "end_date"]],
  ])("rejects a meal tool requiring %s", async (_case, required) => {
    const mealTool = structuredClone(VERIFIED_ZIVA_MEAL_TOOL);
    mealTool.inputSchema.required = required;
    const harness = createFakeZivaMcpHarness({ toolPages: [[mealTool]] });

    const connection = await ZivaMcpClient.connect({
      accessToken: ACCESS_TOKEN,
      fetchFn: harness.fetch,
    }).catch((error: unknown) => error);
    if (connection instanceof ZivaMcpClient) await connection.close();

    expect(connection).toBeInstanceOf(ZivaMcpToolError);
    expect(harness.transportClosed).toBe(true);
  });

  it("classifies HTTP 401 without exposing the response body", async () => {
    const privateBody = "private-token-from-server";
    const harness = createFakeZivaMcpHarness({
      httpErrors: { "tools/call": { status: 401, body: privateBody } },
    });

    const error = await withClient(harness, (client) =>
      client.getMealsForDate(EXPECTED_DATE),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ZivaMcpAuthenticationError);
    expect(error).not.toHaveProperty("cause");
    expect(error).not.toHaveProperty("message", expect.stringContaining(privateBody));
    expect(telemetryMocks.captureException).not.toHaveBeenCalled();
  });

  it("preserves typed rate-limit metadata without exposing the response body", async () => {
    const privateBody = "private rate-limit response body";
    const harness = createFakeZivaMcpHarness({
      httpErrors: {
        "tools/call": {
          status: 429,
          body: privateBody,
          headers: { "Retry-After": "17" },
        },
      },
    });

    const error = await withClient(harness, (client) =>
      client.getMealsForDate(EXPECTED_DATE),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderRateLimitError);
    expect(error).toMatchObject({
      name: "ProviderRateLimitError",
      providerId: "ziva",
      statusCode: 429,
      retryAfterSeconds: 17,
      scope: "provider",
      userId: null,
      responseBody: "",
    });
    expect(String(error)).not.toContain(privateBody);
    expect(JSON.stringify(error)).not.toContain(privateBody);
    expect(telemetryMocks.captureException).not.toHaveBeenCalled();
    expect(harness.toolCalls).toHaveLength(0);
  });

  it("preserves typed service-unavailable metadata without exposing the response body", async () => {
    const privateBody = "private service response body";
    const harness = createFakeZivaMcpHarness({
      httpErrors: {
        "tools/call": {
          status: 503,
          body: privateBody,
          headers: { "Retry-After": "23" },
        },
      },
    });

    const error = await withClient(harness, (client) =>
      client.getMealsForDate(EXPECTED_DATE),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderServiceUnavailableError);
    expect(error).toMatchObject({
      name: "ProviderServiceUnavailableError",
      providerId: "ziva",
      statusCode: 503,
      retryAfterSeconds: 23,
      scope: "provider",
      userId: null,
      responseBody: "",
    });
    expect(String(error)).not.toContain(privateBody);
    expect(JSON.stringify(error)).not.toContain(privateBody);
    expect(telemetryMocks.captureException).not.toHaveBeenCalled();
    expect(harness.toolCalls).toHaveLength(0);
  });

  it("preserves typed provider timeout metadata without retaining its private cause", async () => {
    const privateMarker = "private provider timeout cause";
    const upstreamError = new ProviderRequestTimeoutError({
      cause: new Error(privateMarker),
      providerId: "ziva",
      scope: "provider",
      timeoutMs: 120_000,
      userId: null,
    });
    const harness = createFakeZivaMcpHarness({
      thrownErrors: { "tools/call": upstreamError },
    });

    const error = await withClient(harness, (client) =>
      client.getMealsForDate(EXPECTED_DATE),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ProviderRequestTimeoutError);
    expect(error).not.toBe(upstreamError);
    expect(error).toMatchObject({
      name: "ProviderRequestTimeoutError",
      code: "ETIMEDOUT",
      providerId: "ziva",
      scope: "provider",
      timeoutMs: 120_000,
      userId: null,
      cause: undefined,
    });
    expect(String(error)).not.toContain(privateMarker);
    expect(telemetryMocks.captureException).not.toHaveBeenCalled();
  });

  it("treats an HTTP-success MCP isError result as a redacted tool failure", async () => {
    const privateMessage = "user-private tool failure";
    const harness = createFakeZivaMcpHarness({
      callResult: {
        isError: true,
        content: [{ type: "text", text: privateMessage }],
      },
    });

    const promise = withClient(harness, (client) => client.getMealsForDate(EXPECTED_DATE));
    await expect(promise).rejects.toBeInstanceOf(ZivaMcpToolError);
    await expect(promise).rejects.not.toThrow(privateMessage);
  });

  it.each([
    ["malformed MCP content", { content: "not-an-array" }],
    [
      "a malformed meal",
      structuredResult({
        ...observedMealFixture,
        meals: [{ ...observedMealFixture.meals[0], macros: { calories: 321 } }],
      }),
    ],
    [
      "multiple JSON text candidates",
      {
        content: [
          { type: "text", text: "{}" },
          { type: "text", text: "{}" },
        ],
      },
    ],
    ["an experimental task-shaped result", { toolResult: { meals: [] } }],
  ])("rejects %s as a malformed response", async (_case, callResult) => {
    const harness = createFakeZivaMcpHarness({ callResult });

    await expect(
      withClient(harness, (client) => client.getMealsForDate(EXPECTED_DATE)),
    ).rejects.toBeInstanceOf(ZivaMcpMalformedResponseError);
  });

  it("enforces the bounded SDK request timeout and closes the pending transport", async () => {
    vi.useFakeTimers();
    const harness = createFakeZivaMcpHarness({
      delayedMethods: { "tools/call": 60_000 },
    });
    const client = await ZivaMcpClient.connect({
      accessToken: ACCESS_TOKEN,
      fetchFn: harness.fetch,
    });

    try {
      const request = client.getMealsForDate(EXPECTED_DATE);
      const rejection = expect(request).rejects.toBeInstanceOf(ZivaMcpTimeoutError);
      await vi.advanceTimersByTimeAsync(30_001);
      await rejection;
      expect(harness.cancellationNotifications).toBe(1);
    } finally {
      await client.close();
      expect(harness.transportClosed).toBe(true);
    }
  });

  it("aborts the whole connect handshake while initialized notification is pending", async () => {
    const harness = createFakeZivaMcpHarness({
      delayedMethods: { "notifications/initialized": Number.POSITIVE_INFINITY },
    });
    const controller = new AbortController();
    const reason = new DOMException("caller stopped connection", "AbortError");
    const connect = ZivaMcpClient.connect({
      accessToken: ACCESS_TOKEN,
      fetchFn: harness.fetch,
      signal: controller.signal,
    });
    const observed = connect.catch((error: unknown) => error);

    await vi.waitFor(() => expect(harness.jsonRpcMethods).toContain("notifications/initialized"));
    controller.abort(reason);
    const pending = Symbol("pending connect");
    const outcome = await Promise.race([
      observed,
      new Promise<typeof pending>((resolve) => setTimeout(() => resolve(pending), 100)),
    ]);

    expect(outcome).toBe(reason);
    expect(harness.transportClosed).toBe(true);
  });

  it("times out the whole connect handshake while initialized notification is pending", async () => {
    vi.useFakeTimers();
    const harness = createFakeZivaMcpHarness({
      delayedMethods: { "notifications/initialized": 60_000 },
    });
    const connect = ZivaMcpClient.connect({
      accessToken: ACCESS_TOKEN,
      fetchFn: harness.fetch,
    });
    const observed = connect.catch((error: unknown) => error);

    await vi.waitFor(() => expect(harness.jsonRpcMethods).toContain("notifications/initialized"));
    await vi.advanceTimersByTimeAsync(30_001);
    const pending = Symbol("pending connect");
    const outcome = await Promise.race([observed, Promise.resolve(pending)]);

    expect(outcome).toBeInstanceOf(ZivaMcpTimeoutError);
    expect(harness.transportClosed).toBe(true);
  });

  it("clears connect cancellation and deadline hooks after a successful handshake", async () => {
    vi.useFakeTimers();
    const harness = createFakeZivaMcpHarness();
    const controller = new AbortController();
    const client = await ZivaMcpClient.connect({
      accessToken: ACCESS_TOKEN,
      fetchFn: harness.fetch,
      signal: controller.signal,
    });

    try {
      controller.abort(new DOMException("late caller cancellation", "AbortError"));
      await vi.advanceTimersByTimeAsync(30_001);

      await expect(client.getMealsForDate(EXPECTED_DATE)).resolves.toEqual({ meals: [] });
      expect(harness.transportClosed).toBe(false);
    } finally {
      await client.close();
      expect(harness.transportClosed).toBe(true);
    }
  });

  it("preserves caller cancellation instead of misclassifying it as a timeout", async () => {
    const harness = createFakeZivaMcpHarness({
      delayedMethods: { "tools/call": Number.POSITIVE_INFINITY },
    });
    const controller = new AbortController();
    const reason = new DOMException("caller stopped sync", "AbortError");

    const promise = withClient(harness, async (client) => {
      const request = client.getMealsForDate(EXPECTED_DATE, { signal: controller.signal });
      await vi.waitFor(() => expect(harness.jsonRpcMethods).toContain("tools/call"));
      controller.abort(reason);
      return request;
    });

    await expect(promise).rejects.toBe(reason);
    expect(harness.cancellationNotifications).toBe(1);
  });

  it("redacts other HTTP response bodies from transport errors", async () => {
    const privateBody = "private-diary-response-body";
    const harness = createFakeZivaMcpHarness({
      httpErrors: { "tools/call": { status: 500, body: privateBody } },
    });

    const error = await withClient(harness, (client) =>
      client.getMealsForDate(EXPECTED_DATE),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ZivaMcpTransportError);
    expect(error).not.toHaveProperty("cause");
    expect(error).not.toHaveProperty("message", expect.stringContaining(privateBody));
    expect(telemetryMocks.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "ZivaMcpTransportError",
        message: "Ziva MCP communication failed.",
      }),
      {
        tags: { provider: "ziva", mcpPhase: "call_tool" },
        extra: { statusCode: 500 },
      },
    );
    expect(telemetryMocks.captureException.mock.calls[0]?.[0]).not.toHaveProperty("cause");
    expect(JSON.stringify(telemetryMocks.captureException.mock.calls)).not.toContain(privateBody);
  });

  it("redacts JSON-RPC protocol error messages and data from errors and telemetry", async () => {
    const privateMessage = "private JSON-RPC diary failure";
    const privateData = "private protocol error data";
    const harness = createFakeZivaMcpHarness({
      jsonRpcErrors: {
        "tools/call": {
          code: -32_603,
          message: privateMessage,
          data: { detail: privateData },
        },
      },
    });

    const error = await withClient(harness, (client) =>
      client.getMealsForDate(EXPECTED_DATE),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ZivaMcpTransportError);
    expect(error).not.toHaveProperty("cause");
    expect(JSON.stringify(error)).not.toContain(privateMessage);
    expect(JSON.stringify(error)).not.toContain(privateData);
    expect(telemetryMocks.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "ZivaMcpTransportError",
        message: "Ziva MCP communication failed.",
      }),
      {
        tags: { provider: "ziva", mcpPhase: "call_tool" },
        extra: { mcpErrorCode: -32_603 },
      },
    );
    expect(telemetryMocks.captureException.mock.calls[0]?.[0]).not.toHaveProperty("cause");
    expect(JSON.stringify(telemetryMocks.captureException.mock.calls)).not.toContain(
      privateMessage,
    );
    expect(JSON.stringify(telemetryMocks.captureException.mock.calls)).not.toContain(privateData);
  });

  it("does not retain a server-supplied timeout-code message as the timeout cause", async () => {
    const privateMessage = "private server timeout detail";
    const harness = createFakeZivaMcpHarness({
      jsonRpcErrors: {
        "tools/call": {
          code: -32_001,
          message: privateMessage,
          data: { diary: "private" },
        },
      },
    });

    const error = await withClient(harness, (client) =>
      client.getMealsForDate(EXPECTED_DATE),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ZivaMcpTimeoutError);
    expect(error).not.toHaveProperty("cause");
    expect(JSON.stringify(error)).not.toContain(privateMessage);
    expect(telemetryMocks.captureException).not.toHaveBeenCalled();
  });

  it("reports unexpected transport failures without retaining private error details", async () => {
    const privateMessage = "private fetch adapter detail";
    const harness = createFakeZivaMcpHarness({
      thrownErrors: { "tools/call": new Error(privateMessage) },
    });

    const error = await withClient(harness, (client) =>
      client.getMealsForDate(EXPECTED_DATE),
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ZivaMcpTransportError);
    expect(error).not.toHaveProperty("cause");
    expect(telemetryMocks.captureException).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "ZivaMcpTransportError",
        message: "Ziva MCP communication failed.",
      }),
      {
        tags: { provider: "ziva", mcpPhase: "call_tool" },
        extra: { errorName: "Error" },
      },
    );
    expect(telemetryMocks.captureException.mock.calls[0]?.[0]).not.toHaveProperty("cause");
    expect(JSON.stringify(telemetryMocks.captureException.mock.calls)).not.toContain(
      privateMessage,
    );
  });
});
