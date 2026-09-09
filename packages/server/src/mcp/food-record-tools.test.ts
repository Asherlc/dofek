import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { captureException } from "dofek/lib/error-reporting";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { FoodRecordError } from "../services/food-record-service.ts";
import type { DofekMcpContext } from "./context.ts";
import { registerFoodRecordTools } from "./food-record-tools.ts";

const mocks = vi.hoisted(() => ({
  create: vi.fn(),
  delete: vi.fn(),
  get: vi.fn(),
  history: vi.fn(),
  restore: vi.fn(),
  search: vi.fn(),
  serviceConstructor: vi.fn(),
  repositoryConstructor: vi.fn(),
  update: vi.fn(),
}));

vi.mock("../repositories/food-record-repository.ts", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../repositories/food-record-repository.ts")>();
  return {
    ...original,
    FoodRecordRepository: vi.fn(function repositoryConstructor(...args: unknown[]) {
      mocks.repositoryConstructor(...args);
      return { get: mocks.get, history: mocks.history, search: mocks.search };
    }),
  };
});

vi.mock("../services/food-record-service.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/food-record-service.ts")>();
  return {
    ...original,
    FoodRecordService: vi.fn(function serviceConstructor(dependencies: unknown) {
      mocks.serviceConstructor(dependencies);
      return {
        create: mocks.create,
        delete: mocks.delete,
        restore: mocks.restore,
        update: mocks.update,
      };
    }),
  };
});

vi.mock("dofek/lib/error-reporting", async (importOriginal) => {
  const original = await importOriginal<typeof import("dofek/lib/error-reporting")>();
  return { ...original, captureException: vi.fn() };
});

const recordId = "11111111-1111-4111-8111-111111111111";
const sourceEntryId = "12111111-1111-4111-8111-111111111111";
const version = "22222222-2222-4222-8222-222222222222";
const requestId = "33333333-3333-4333-8333-333333333333";
const changeId = "44444444-4444-4444-8444-444444444444";

const domainRecord = {
  recordId,
  sourceEntryId,
  version,
  deleted: false,
  modifiable: true,
  modificationUnavailableReason: null,
  date: "2026-09-07",
  meal: "breakfast",
  foodName: "Oats",
  foodDescription: null,
  category: "breads_and_cereals",
  numberOfUnits: 1,
  servingUnit: "bowl",
  servingWeightGrams: 80,
  nutrients: { calories: 300, protein: 10 },
  sourceProvider: "dofek",
  provenance: {
    foodName: { origin: "human" as const, changeId },
    foodDescription: { origin: "source" as const, changeId: null },
    numberOfUnits: { origin: "source" as const, changeId: null },
    servingUnit: { origin: "source" as const, changeId: null },
    servingWeightGrams: { origin: "human" as const, changeId },
    "nutrients.protein": { origin: "human" as const, changeId },
    meal: { origin: "source" as const, changeId: null },
  },
};

const wireRecord = {
  record_id: recordId,
  source_entry_id: sourceEntryId,
  version,
  deleted: false,
  modifiable: true,
  modification_unavailable_reason: null,
  date: "2026-09-07",
  meal: "breakfast",
  food_name: "Oats",
  food_description: null,
  category: "breads_and_cereals",
  number_of_units: 1,
  serving_unit: "bowl",
  serving_weight_grams: 80,
  nutrients: { calories: 300, protein: 10 },
  source_provider: "dofek",
  provenance: {
    food_name: { origin: "human", change_id: changeId },
    food_description: { origin: "source", change_id: null },
    number_of_units: { origin: "source", change_id: null },
    serving_unit: { origin: "source", change_id: null },
    serving_weight_grams: { origin: "human", change_id: changeId },
    "nutrients.protein": { origin: "human", change_id: changeId },
    meal: { origin: "source", change_id: null },
  },
};

type ToolHandler = (input: Record<string, unknown>) => Promise<unknown>;
interface RegisteredTool {
  annotations: Record<string, boolean>;
  inputSchema: Record<string, z.ZodType>;
  outputSchema: z.ZodType;
  handler: ToolHandler;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSchemaRecord(value: unknown): value is Record<string, z.ZodType> {
  return isRecord(value) && Object.values(value).every((schema) => schema instanceof z.ZodType);
}

function registeredToolFromCall(call: unknown): [string, RegisteredTool] {
  if (!Array.isArray(call) || typeof call[0] !== "string") {
    throw new Error("Unexpected registerTool call");
  }
  const config = call[1];
  const handler = call[2];
  if (
    !isRecord(config) ||
    !isRecord(config.annotations) ||
    !Object.values(config.annotations).every((value) => typeof value === "boolean") ||
    !isSchemaRecord(config.inputSchema) ||
    !(config.outputSchema instanceof z.ZodType) ||
    typeof handler !== "function"
  ) {
    throw new Error(`Tool ${call[0]} has an unexpected registration`);
  }
  return [
    call[0],
    {
      annotations: config.annotations,
      inputSchema: config.inputSchema,
      outputSchema: config.outputSchema,
      handler,
    },
  ];
}

function setup(scopes: DofekMcpContext["scopes"] = ["nutrition:read", "nutrition:write"]) {
  const server = new McpServer({ name: "food-record-tools-test", version: "1.0.0" });
  const registerTool = vi.spyOn(server, "registerTool");
  const context: DofekMcpContext = {
    db: { execute: vi.fn(), select: vi.fn(), transaction: vi.fn() },
    userId: "user-id",
    clientId: "oauth:client-id",
    scopes,
    timezone: "UTC",
  };
  registerFoodRecordTools(server, context);
  const tools = new Map(registerTool.mock.calls.map(registeredToolFromCall));
  const tool = (name: string): RegisteredTool => {
    const registered = tools.get(name);
    if (!registered) throw new Error(`Tool ${name} was not registered`);
    return registered;
  };
  return { context, tool, tools };
}

function parseResult(result: unknown): unknown {
  return JSON.parse(
    z
      .object({ content: z.array(z.object({ type: z.literal("text"), text: z.string() })) })
      .parse(result).content[0]?.text ?? "null",
  );
}

function structuredContent(result: unknown): unknown {
  return z.object({ structuredContent: z.unknown() }).parse(result).structuredContent;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.search.mockResolvedValue({ items: [domainRecord], nextCursor: null });
  mocks.get.mockResolvedValue(domainRecord);
  mocks.history.mockResolvedValue({ recordId, items: [], nextCursor: null });
  for (const mutation of [mocks.create, mocks.update, mocks.delete, mocks.restore]) {
    mutation.mockResolvedValue({
      operation: { changeId, resultingVersion: version, replayed: false },
      record: domainRecord,
      affectedDates: ["2026-09-07"],
    });
  }
});

describe("registerFoodRecordTools", () => {
  it("registers the exact seven tools with concrete schemas and annotations", () => {
    const { tool, tools } = setup();

    expect([...tools.keys()]).toEqual([
      "search_food_entries",
      "get_food_entry",
      "create_food_entry",
      "update_food_entry",
      "delete_food_entry",
      "restore_food_entry",
      "get_food_entry_history",
    ]);
    for (const name of ["search_food_entries", "get_food_entry", "get_food_entry_history"]) {
      expect(tool(name).annotations).toEqual({ readOnlyHint: true, openWorldHint: false });
      expect(Object.keys(tool(name).inputSchema).length).toBeGreaterThan(0);
      expect(tool(name).outputSchema).toBeInstanceOf(z.ZodType);
    }
    for (const name of ["create_food_entry", "update_food_entry", "restore_food_entry"]) {
      expect(tool(name).annotations).toEqual({
        readOnlyHint: false,
        openWorldHint: false,
        destructiveHint: false,
        idempotentHint: true,
      });
    }
    expect(tool("delete_food_entry").annotations).toEqual({
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: true,
      idempotentHint: true,
    });
    expect(Object.keys(tool("update_food_entry").inputSchema)).toEqual([
      "record_id",
      "expected_version",
      "request_id",
      "set",
      "clear",
      "nutrient_set",
      "nutrient_clear",
    ]);
    expect(Object.keys(tool("create_food_entry").inputSchema)).not.toContain("client_id");
  });

  it("maps search input, records, provenance, and cursors to snake case", async () => {
    const { tool } = setup();
    mocks.search.mockResolvedValue({
      items: [domainRecord],
      nextCursor: { recordId },
    });

    const result = await tool("search_food_entries").handler({
      start_date: "2026-09-01",
      end_date: "2026-09-07",
      query: "oats",
      visibility: "all",
      cursor: { record_id: recordId },
      limit: 20,
    });

    expect(mocks.search).toHaveBeenCalledWith({
      startDate: "2026-09-01",
      endDate: "2026-09-07",
      query: "oats",
      visibility: "all",
      cursor: { recordId },
      limit: 20,
    });
    expect(parseResult(result)).toEqual({
      items: [wireRecord],
      next_cursor: { record_id: recordId },
    });
    expect(
      tool("search_food_entries").outputSchema.safeParse(structuredContent(result)).success,
    ).toBe(true);
  });

  it("applies documented search and history defaults", async () => {
    const { tool } = setup();

    await tool("search_food_entries").handler({
      start_date: "2026-09-01",
      end_date: "2026-09-07",
    });
    await tool("get_food_entry_history").handler({ record_id: recordId });

    expect(mocks.search).toHaveBeenCalledWith({
      startDate: "2026-09-01",
      endDate: "2026-09-07",
      query: null,
      visibility: "visible",
      cursor: null,
      limit: 50,
    });
    expect(mocks.history).toHaveBeenCalledWith(recordId, null, 50);
  });

  it("enforces search text and pagination schema boundaries", () => {
    const { tool } = setup();
    const search = tool("search_food_entries").inputSchema;
    const history = tool("get_food_entry_history").inputSchema;

    expect(search.query?.safeParse(" ").success).toBe(false);
    expect(search.query?.safeParse("oats").success).toBe(true);
    expect(search.limit?.safeParse(0).success).toBe(false);
    expect(search.limit?.safeParse(1).success).toBe(true);
    expect(search.limit?.safeParse(100).success).toBe(true);
    expect(search.limit?.safeParse(101).success).toBe(false);
    expect(history.limit?.safeParse(0).success).toBe(false);
    expect(history.limit?.safeParse(1).success).toBe(true);
    expect(history.limit?.safeParse(100).success).toBe(true);
    expect(history.limit?.safeParse(101).success).toBe(false);
  });

  it("rejects an inverted search range before calling the repository", async () => {
    const { tool } = setup();

    const result = await tool("search_food_entries").handler({
      start_date: "2026-09-08",
      end_date: "2026-09-07",
    });

    expect(parseResult(result)).toEqual({
      error: {
        code: "INVALID_ARGUMENT",
        message: "start_date must be on or before end_date",
      },
    });
    expect(result).toMatchObject({ isError: true });
    expect(mocks.search).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
  });

  it("maps detail and history output without exposing camel-case fields", async () => {
    const { tool } = setup();
    mocks.history.mockResolvedValue({
      recordId,
      nextCursor: "history-cursor",
      items: [
        {
          changeId,
          requestId,
          version,
          predecessorVersion: null,
          kind: "update",
          channel: "mcp",
          clientId: "oauth:client-id",
          recordedAt: "2026-09-07T12:00:00.000Z",
          effectiveAt: null,
          schemaVersion: 1,
          undoChangeId: null,
          deleted: null,
          fields: { food_name: { operation: "set", value: "Oats" } },
          nutrients: { protein: { operation: "set", amount: 10 } },
        },
      ],
    });

    expect(parseResult(await tool("get_food_entry").handler({ record_id: recordId }))).toEqual(
      wireRecord,
    );
    const historyResult = await tool("get_food_entry_history").handler({
      record_id: recordId,
      cursor: null,
      limit: 10,
    });
    expect(mocks.history).toHaveBeenCalledWith(recordId, null, 10);
    expect(parseResult(historyResult)).toEqual({
      record_id: recordId,
      next_cursor: "history-cursor",
      items: [
        {
          change_id: changeId,
          request_id: requestId,
          version,
          predecessor_version: null,
          kind: "update",
          channel: "mcp",
          client_id: "oauth:client-id",
          recorded_at: "2026-09-07T12:00:00.000Z",
          effective_at: null,
          schema_version: 1,
          undo_change_id: null,
          deleted: null,
          fields: { food_name: { operation: "set", value: "Oats" } },
          nutrients: { protein: { operation: "set", amount: 10 } },
        },
      ],
    });
    expect(
      tool("get_food_entry_history").outputSchema.safeParse(structuredContent(historyResult))
        .success,
    ).toBe(true);
  });

  it("returns null when a food record is not found", async () => {
    const { tool } = setup();
    mocks.get.mockResolvedValueOnce(null);

    expect(parseResult(await tool("get_food_entry").handler({ record_id: recordId }))).toBeNull();
  });

  it("uses authenticated user and client attribution for mutations", async () => {
    const { context, tool } = setup();

    await tool("create_food_entry").handler({
      request_id: requestId,
      date: "2026-09-07",
      food_name: "Oats",
      nutrients: { protein: 10 },
      client_id: "attacker-supplied",
    });

    expect(mocks.serviceConstructor).toHaveBeenCalledWith({
      database: context.db,
      userId: "user-id",
      actor: { channel: "mcp", clientId: "oauth:client-id" },
    });
    expect(mocks.create).toHaveBeenCalledWith({
      requestId,
      date: "2026-09-07",
      meal: undefined,
      foodName: "Oats",
      foodDescription: undefined,
      category: undefined,
      numberOfUnits: undefined,
      servingUnit: undefined,
      servingWeightGrams: undefined,
      nutrients: { protein: 10 },
    });
  });

  it("maps update, delete, and restore commands to service inputs", async () => {
    const { tool } = setup();
    await tool("update_food_entry").handler({
      record_id: recordId,
      expected_version: version,
      request_id: requestId,
      set: { food_name: "Porridge", serving_weight_grams: 90 },
      clear: ["meal"],
      nutrient_set: { protein: 12, calories: null },
      nutrient_clear: ["fiber"],
    });
    expect(mocks.update).toHaveBeenCalledWith({
      recordId,
      expectedVersion: version,
      requestId,
      set: { foodName: "Porridge", servingWeightGrams: 90 },
      clear: ["meal"],
      nutrientSet: { protein: 12, calories: null },
      nutrientClear: ["fiber"],
    });

    for (const [name, method] of [
      ["delete_food_entry", mocks.delete],
      ["restore_food_entry", mocks.restore],
    ] as const) {
      await tool(name).handler({
        record_id: recordId,
        expected_version: null,
        request_id: requestId,
      });
      expect(method).toHaveBeenCalledWith({
        recordId,
        expectedVersion: null,
        requestId,
      });
    }
  });

  it("maps every scalar update field while preserving explicit nulls", async () => {
    const { tool } = setup();

    await tool("update_food_entry").handler({
      record_id: recordId,
      expected_version: version,
      request_id: requestId,
      set: {
        date: "2026-09-08",
        meal: null,
        food_name: null,
        food_description: "Cooked slowly",
        category: null,
        number_of_units: null,
        serving_unit: "bowl",
        serving_weight_grams: null,
      },
      clear: [
        "date",
        "food_name",
        "food_description",
        "category",
        "number_of_units",
        "serving_unit",
        "serving_weight_grams",
      ],
      nutrient_set: {},
      nutrient_clear: [],
    });

    expect(mocks.update).toHaveBeenCalledWith({
      recordId,
      expectedVersion: version,
      requestId,
      set: {
        date: "2026-09-08",
        meal: null,
        foodName: null,
        foodDescription: "Cooked slowly",
        category: null,
        numberOfUnits: null,
        servingUnit: "bowl",
        servingWeightGrams: null,
      },
      clear: [
        "date",
        "foodName",
        "foodDescription",
        "category",
        "numberOfUnits",
        "servingUnit",
        "servingWeightGrams",
      ],
      nutrientSet: {},
      nutrientClear: [],
    });
  });

  it("enforces nonempty create food names", () => {
    const { tool } = setup();
    const foodName = tool("create_food_entry").inputSchema.food_name;

    expect(foodName?.safeParse(" ").success).toBe(false);
    expect(foodName?.safeParse("Oats").success).toBe(true);
  });

  it("returns mutation receipts and records while omitting affected dates", async () => {
    const { tool } = setup();

    const result = await tool("delete_food_entry").handler({
      record_id: recordId,
      expected_version: version,
      request_id: requestId,
    });

    expect(parseResult(result)).toEqual({
      operation: {
        change_id: changeId,
        resulting_version: version,
        replayed: false,
      },
      record: wireRecord,
    });
    expect(
      tool("delete_food_entry").outputSchema.safeParse(structuredContent(result)).success,
    ).toBe(true);
  });

  it("requires nutrition read scope for every read", async () => {
    const { tool } = setup([]);

    for (const [name, input] of [
      ["search_food_entries", { start_date: "2026-09-01", end_date: "2026-09-07" }],
      ["get_food_entry", { record_id: recordId }],
      ["get_food_entry_history", { record_id: recordId }],
    ] as const) {
      await expect(tool(name).handler(input)).rejects.toMatchObject({
        code: "insufficient_scope",
      });
    }
    expect(mocks.search).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
    expect(mocks.history).not.toHaveBeenCalled();
  });

  it.each([
    ["nutrition read", ["nutrition:write"]],
    ["nutrition write", ["nutrition:read"]],
  ] as const)("requires %s scope for mutations", async (_label, scopes) => {
    const { tool } = setup([...scopes]);

    await expect(
      tool("delete_food_entry").handler({
        record_id: recordId,
        expected_version: version,
        request_id: requestId,
      }),
    ).rejects.toMatchObject({ code: "insufficient_scope" });
    expect(mocks.delete).not.toHaveBeenCalled();
  });

  it.each([
    ["NOT_FOUND", { recordId }, { record_id: recordId }],
    ["PRECONDITION_FAILED", { sourceEntryId }, { source_entry_id: sourceEntryId }],
    [
      "CONFLICT",
      { recordId, currentVersion: version },
      { record_id: recordId, current_version: version },
    ],
    [
      "INVALID_ARGUMENT",
      { issues: [{ path: "foodName", message: "Required" }] },
      { issues: [{ path: "foodName", message: "Required" }] },
    ],
    ["ACCOUNT_ERASURE_ACTIVE", {}, undefined],
  ] as const)(
    "maps %s domain errors to safe JSON tool errors",
    async (code, details, wantDetails) => {
      const { tool } = setup();
      mocks.update.mockRejectedValueOnce(new FoodRecordError(code, `Actionable ${code}`, details));

      const result = await tool("update_food_entry").handler({
        record_id: recordId,
        expected_version: version,
        request_id: requestId,
        set: { food_name: "Porridge" },
        clear: [],
        nutrient_set: {},
        nutrient_clear: [],
      });

      expect(result).toMatchObject({ isError: true });
      expect(parseResult(result)).toEqual({
        error: {
          code,
          message: `Actionable ${code}`,
          ...(wantDetails ? { details: wantDetails } : {}),
        },
      });
      expect(captureException).not.toHaveBeenCalled();
    },
  );

  it("recursively converts safe error detail keys to snake case", async () => {
    const { tool } = setup();
    mocks.update.mockRejectedValueOnce(
      new FoodRecordError("INVALID_ARGUMENT", "Nested details", {
        outerField: [{ innerField: "value" }],
        nullValue: null,
        scalarList: [1, "two"],
      }),
    );

    const result = await tool("update_food_entry").handler({
      record_id: recordId,
      expected_version: version,
      request_id: requestId,
      set: { food_name: "Porridge" },
      clear: [],
      nutrient_set: {},
      nutrient_clear: [],
    });

    expect(parseResult(result)).toEqual({
      error: {
        code: "INVALID_ARGUMENT",
        message: "Nested details",
        details: {
          outer_field: [{ inner_field: "value" }],
          null_value: null,
          scalar_list: [1, "two"],
        },
      },
    });
  });

  it("reports unexpected failures and returns no internal details", async () => {
    const { tool } = setup();
    const secret = "private-food-value-8321";
    const internalError = Object.assign(new Error(`Failed query: ${secret}`), {
      query: `INSERT ${secret}`,
      params: [secret],
      cause: Object.assign(new Error(`Invalid food ${secret}`), { code: "23514" }),
    });
    mocks.create.mockRejectedValueOnce(internalError);

    const result = await tool("create_food_entry").handler({
      request_id: requestId,
      date: "2026-09-07",
      food_name: "Oats",
      nutrients: {},
    });

    expect(captureException).toHaveBeenCalledOnce();
    const captured = vi.mocked(captureException).mock.calls;
    expect(
      JSON.stringify(captured, (_key, value: unknown) =>
        value instanceof Error
          ? Object.fromEntries(
              Object.getOwnPropertyNames(value).map((key) => [key, Reflect.get(value, key)]),
            )
          : value,
      ),
    ).not.toContain(secret);
    expect(captured[0]?.[0]).toMatchObject({
      name: "FoodRecordUnexpectedError",
      message: "Food record mcp_tool failed [23514]",
    });
    expect(captured[0]?.[0]).not.toHaveProperty("cause");
    expect(captured[0]?.[1]).toEqual({
      tags: { source: "food-record", operation: "mcp_tool", error_code: "23514" },
    });
    expect(parseResult(result)).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "The food record request could not be completed.",
      },
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});
