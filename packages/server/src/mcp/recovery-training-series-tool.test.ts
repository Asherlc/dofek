import { CANONICAL_ACTIVITY_TYPES } from "@dofek/training/activity-types";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { recoveryTrainingSeriesOutputSchema } from "./recovery-training-series-output.ts";

const mocks = vi.hoisted(() => ({
  constructorArgs: vi.fn(),
  listRange: vi.fn(),
  sensorQuery: vi.fn(),
  execute: vi.fn(),
}));

vi.mock("../repositories/recovery-training-series-repository.ts", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../repositories/recovery-training-series-repository.ts")>();
  return {
    ...original,
    RecoveryTrainingSeriesRepository: vi.fn(function vitestConstructor(...args: unknown[]) {
      mocks.constructorArgs(...args);
      return { listRange: mocks.listRange };
    }),
  };
});

import { registerRecoveryTrainingSeriesTool } from "./recovery-training-series-tool.ts";

describe("get_recovery_training_series", () => {
  let client: Client;
  let server: McpServer;
  const userId = "00000000-0000-4000-8000-000000000002";
  const range = { start_date: "2026-03-08", end_date: "2026-03-09" };

  beforeEach(async () => {
    mocks.constructorArgs.mockReset();
    mocks.sensorQuery.mockReset().mockResolvedValue([]);
    mocks.execute.mockReset().mockResolvedValue([]);
    mocks.listRange.mockReset().mockResolvedValue({
      range: { start_date: "2026-03-08", end_date: "2026-03-09", timezone: "UTC" },
      requested_streams: ["health"],
      filters: { providers: [], modalities: [] },
      interpretation: {
        date_alignment: "Local calendar dates.",
        causality: "No causal claims.",
        filter_scope: "Filters apply to activity-derived streams.",
      },
      rows: [
        {
          date: "2026-03-08",
          health: {
            hrv: {
              value: 52,
              status: "observed",
              value_kind: "provider_supplied",
              source_providers: ["apple_health"],
              provenance_scope: "daily_row",
            },
            resting_hr: {
              value: null,
              status: "missing",
              value_kind: "calculated_from_deduped_samples",
              source_providers: [],
              provenance_scope: "deduped_resting_hr_series",
            },
            respiratory_rate: {
              value: 14,
              status: "observed",
              value_kind: "provider_supplied",
              source_providers: ["apple_health"],
              provenance_scope: "daily_row",
            },
            steps: {
              value: 8000,
              status: "observed",
              value_kind: "provider_supplied",
              source_providers: ["apple_health"],
              provenance_scope: "daily_row",
            },
          },
        },
      ],
    });
    server = new McpServer({ name: "recovery-series-test", version: "1.0.0" });
    registerRecoveryTrainingSeriesTool(server, {
      db: { execute: mocks.execute, select: vi.fn(), transaction: vi.fn() },
      userId,
      scopes: ["health:read", "nutrition:read", "activity:read"],
      timezone: "UTC",
      sensorStore: { query: mocks.sensorQuery },
    });
    client = new Client({ name: "recovery-series-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await server.close();
  });

  async function call(arguments_: Record<string, unknown>) {
    return client.callTool({
      name: "get_recovery_training_series",
      arguments: { ...range, ...arguments_ },
    });
  }

  it.each(["8:00", "24:00", "20:60", "20:0x", "x20:00", "20:00Z"])(
    "rejects invalid local workout cutoff %s",
    async (workout_finish_after) => {
      const response = await call({ grain: "main_sleep", workout_finish_after });
      expect(response.isError).toBe(true);
      expect(mocks.listRange).not.toHaveBeenCalled();
    },
  );

  it.each([
    { fields: [] },
    { fields: Array(8).fill("health") },
    { canonical_activity_types: [...CANONICAL_ACTIVITY_TYPES, "cycling"] },
    { required_meals: Array(6).fill("lunch") },
    { cursor: "" },
    { limit: 0 },
    { limit: 367 },
  ])("rejects requests beyond its input bounds %j", async (args) => {
    const response = await call(args);
    expect(response.isError).toBe(true);
    expect(mocks.listRange).not.toHaveBeenCalled();
  });

  it.each([
    [{ fields: ["sleep"], streams: ["sleep"] }, "Select fields or streams"],
    [
      { grain: "main_sleep", required_meals: ["lunch"] },
      "required_meals is available for local_day",
    ],
    [{ workout_finish_after: "20:00" }, "workout_finish_after is available for main_sleep"],
    [{ timezone: "+04:00" }, "Expected an IANA timezone"],
  ])("rejects invalid series arguments %j before loading a stream", async (args, message) => {
    const response = await call(args);
    expect(response.isError).toBe(true);
    expect(response.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining(message),
    });
    expect(mocks.listRange).not.toHaveBeenCalled();
  });

  it("accepts 366 inclusive days and rejects a cursor outside the selected rows", async () => {
    const response = await call({
      start_date: "2025-01-01",
      end_date: "2026-01-01",
      fields: ["health"],
      cursor: "missing",
    });
    expect(response.isError).toBe(true);
    expect(response.content[0]).toMatchObject({
      type: "text",
      text: expect.stringContaining("The cursor does not match this series"),
    });
  });

  it("loads nutrition to qualify local days and returns only selected fields", async () => {
    const base = await mocks.listRange();
    mocks.listRange.mockClear();
    const nutrition = (date: string, labels: string[]) => ({
      date,
      total_calories: 300,
      protein_g: null,
      carbs_g: 30,
      fat_g: null,
      fiber_g: null,
      meal_count: labels.length,
      food_entry_count: labels.length,
      recorded_meal_labels: labels,
      timed_food_entry_count: 0,
      first_consumed_at: null,
      last_consumed_at: null,
      missing_nutrient_inputs: [],
      logging_completeness: "unknown_completeness",
      logging_completeness_reason: "No status recorded",
      resolution_status: "available",
      resolution_message: "Resolved",
      source_provider: "dofek",
      source_providers: ["dofek"],
      contributing_providers: ["dofek"],
      excluded_providers: [],
    });
    mocks.listRange.mockResolvedValue({
      ...base,
      rows: [
        { ...base.rows[0], nutrition: nutrition("2026-03-08", ["lunch", "dinner"]) },
        { date: "2026-03-09", nutrition: nutrition("2026-03-09", ["dinner"]) },
      ],
    });
    const args = {
      start_date: "2026-03-08",
      timezone: "America/Los_Angeles",
      fields: ["health", "health"],
      required_meals: ["lunch", "dinner"],
      canonical_activity_types: ["running"],
      limit: 1,
    };
    const response = await call(args);
    const result = recoveryTrainingSeriesOutputSchema.parse(response.structuredContent).result;
    expect(result).toMatchObject({
      requested_fields: ["health"],
      requested_streams: ["health"],
      grain: "local_day",
      calendar_day_count: 2,
      eligible_count: 1,
      next_cursor: null,
      observed_counts: { health: 1, "health.hrv": 1 },
      filters: { canonical_activity_types: ["running"], required_meals: ["lunch", "dinner"] },
    });
    expect(result.rows).toEqual([{ ...base.rows[0], weekday: "Sunday" }]);
    expect(mocks.listRange).toHaveBeenCalledWith(
      "2026-03-08",
      "2026-03-09",
      ["health", "nutrition"],
      {
        canonicalTypes: ["running"],
        datePolicy: "analysis_timezone",
        modalities: [],
        providers: [],
      },
    );
    expect(mocks.constructorArgs.mock.calls.at(-1)?.[1]).toBe("America/Los_Angeles");

    const relaxed = await call({ ...args, required_meals: ["dinner"] });
    expect(
      recoveryTrainingSeriesOutputSchema.parse(relaxed.structuredContent).result,
    ).toMatchObject({
      eligible_count: 2,
      next_cursor: "2026-03-08",
    });
  });

  it("joins main sleep to its preceding wake and counts the inclusive finish boundary", async () => {
    const firstId = "01000000-0000-4000-8000-000000000001";
    const nextId = "01000000-0000-4000-8000-000000000002";
    const episode = (id: string, date: string) => ({
      selected_session_id: id,
      source_session_ids: [id],
      source_providers: ["whoop"],
      provider_id: "whoop",
      source_name: "WHOOP",
      started_at: `${date}T06:00:00Z`,
      ended_at: `${date}T15:00:00Z`,
      timezone: null,
      start_utc_offset_minutes: null,
      end_utc_offset_minutes: null,
      local_time_source: "unknown",
      is_nap: false,
      sleep_kind_recorded: true,
      duration_minutes: 500,
      efficiency_pct: null,
      deep_minutes: null,
      rem_minutes: null,
      light_minutes: null,
      awake_minutes: 40,
      staging_available: false,
    });
    mocks.sensorQuery.mockResolvedValue([
      episode(firstId, "2026-03-07"),
      episode(nextId, "2026-03-08"),
    ]);
    mocks.execute.mockResolvedValue([
      {
        sleep_id: nextId,
        id: "workout",
        canonical_type: "running",
        started_at: "2026-03-08T03:00:00Z",
        ended_at: "2026-03-08T04:00:00Z",
        source_providers: ["whoop"],
        matches_filter: true,
      },
    ]);
    const response = await call({
      grain: "main_sleep",
      timezone: "America/Los_Angeles",
      providers: ["whoop"],
      canonical_activity_types: ["running"],
      workout_finish_after: "20:00",
    });
    const result = recoveryTrainingSeriesOutputSchema.parse(response.structuredContent).result;
    expect(result).toMatchObject({
      requested_fields: ["sleep", "activity_exposure"],
      requested_streams: ["sleep", "activities"],
      grain: "main_sleep",
      eligible_count: 1,
      workout_finish_counts: [{ weekday: "Sunday", before: 0, at_or_after: 1, unknown: 0 }],
      rows: [
        {
          date: "2026-03-08",
          row_id: nextId,
          sleep: {
            selected_session_id: nextId,
            timezone_source: "caller",
            local_wake_time: "08:00:00",
          },
          activity_exposure: {
            previous_wake: { session_id: firstId },
            last_activity: { id: "workout", local_end_time: "20:00:00" },
            minutes_to_sleep: 120,
          },
        },
      ],
    });
    expect(mocks.sensorQuery).toHaveBeenCalledWith(expect.any(Object), expect.any(String), {
      userId,
      startDate: "2026-03-05",
      endDate: "2026-03-09",
      providers: ["whoop"],
      includeNaps: false,
    });
    expect(mocks.listRange).toHaveBeenCalledWith("2026-03-08", "2026-03-09", [], {
      providers: ["whoop"],
      modalities: [],
      canonicalTypes: ["running"],
      datePolicy: "analysis_timezone",
    });
  });

  it.each(["health", "sleep", "body_weight"] as const)(
    "requires health permission for %s even when activity access is granted",
    async (stream) => {
      const scopedServer = new McpServer({ name: "scope-series-test", version: "1.0.0" });
      registerRecoveryTrainingSeriesTool(scopedServer, {
        db: { execute: vi.fn(), select: vi.fn(), transaction: vi.fn() },
        userId: "00000000-0000-4000-8000-000000000002",
        scopes: ["activity:read"],
        timezone: "UTC",
        sensorStore: { query: vi.fn() },
      });
      const scopedClient = new Client({ name: "scope-series-client", version: "1.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await scopedServer.connect(serverTransport);
      await scopedClient.connect(clientTransport);
      try {
        const result = await scopedClient.callTool({
          name: "get_recovery_training_series",
          arguments: {
            start_date: "2026-03-08",
            end_date: "2026-03-08",
            streams: [stream, "activities"],
          },
        });
        expect(result.isError).toBe(true);
        expect(result.content[0]).toMatchObject({
          type: "text",
          text: expect.stringContaining("health:read"),
        });
        expect(mocks.constructorArgs).not.toHaveBeenCalled();
        expect(mocks.listRange).not.toHaveBeenCalled();
      } finally {
        await scopedClient.close();
        await scopedServer.close();
      }
    },
  );

  it("returns only the requested compact streams", async () => {
    const result = await client.callTool({
      name: "get_recovery_training_series",
      arguments: {
        start_date: "2026-03-08",
        end_date: "2026-03-09",
        streams: ["health"],
      },
    });

    if (result.isError)
      throw new Error(result.content[0]?.type === "text" ? result.content[0].text : "Tool failed");
    expect(recoveryTrainingSeriesOutputSchema.parse(result.structuredContent).result.rows).toEqual([
      expect.objectContaining({ date: "2026-03-08", health: expect.any(Object) }),
    ]);
    expect(mocks.listRange).toHaveBeenCalledWith("2026-03-08", "2026-03-09", ["health"], {
      providers: [],
      modalities: [],
    });
    expect(mocks.constructorArgs.mock.calls[0]?.[0]).toEqual({
      dailyMetrics: expect.any(Object),
    });
    expect(mocks.constructorArgs.mock.calls[0]?.[1]).toBe("UTC");
  });

  it("constructs every requested source and forwards explicit activity filters", async () => {
    const allStreams = [
      "health",
      "sleep",
      "body_weight",
      "training_load",
      "activities",
      "nutrition",
    ];
    const scopedServer = new McpServer({ name: "all-series-test", version: "1.0.0" });
    registerRecoveryTrainingSeriesTool(scopedServer, {
      db: { execute: vi.fn(), select: vi.fn(), transaction: vi.fn() },
      userId: "00000000-0000-4000-8000-000000000002",
      scopes: ["health:read", "activity:read", "nutrition:read"],
      timezone: "America/Los_Angeles",
      sensorStore: { query: vi.fn() },
    });
    const scopedClient = new Client({ name: "all-series-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await scopedServer.connect(serverTransport);
    await scopedClient.connect(clientTransport);
    mocks.listRange.mockResolvedValueOnce({
      range: {
        start_date: "2026-03-08",
        end_date: "2026-03-08",
        timezone: "America/Los_Angeles",
      },
      requested_streams: allStreams,
      filters: { providers: ["wahoo"], modalities: ["road"] },
      interpretation: {
        date_alignment: "Local calendar dates.",
        causality: "No causal claims.",
        filter_scope: "Filters apply to activity-derived streams.",
      },
      rows: [{ date: "2026-03-08" }],
    });

    try {
      const result = await scopedClient.callTool({
        name: "get_recovery_training_series",
        arguments: {
          start_date: "2026-03-08",
          end_date: "2026-03-08",
          streams: allStreams,
          providers: ["wahoo"],
          modalities: ["road"],
        },
      });

      if (result.isError)
        throw new Error(
          result.content[0]?.type === "text" ? result.content[0].text : "Tool failed",
        );
      expect(Object.keys(mocks.constructorArgs.mock.calls.at(-1)?.[0] ?? {}).sort()).toEqual([
        "activities",
        "body",
        "dailyMetrics",
        "nutrition",
        "sleep",
        "trainingLoad",
        "weightObservations",
      ]);
      expect(mocks.constructorArgs.mock.calls.at(-1)?.[1]).toBe("America/Los_Angeles");
      expect(mocks.listRange).toHaveBeenLastCalledWith("2026-03-08", "2026-03-08", allStreams, {
        providers: ["wahoo"],
        modalities: ["road"],
      });
    } finally {
      await scopedClient.close();
      await scopedServer.close();
    }
  });

  it("uses the five default non-nutrition streams", async () => {
    const scopedServer = new McpServer({ name: "default-series-test", version: "1.0.0" });
    registerRecoveryTrainingSeriesTool(scopedServer, {
      db: { execute: vi.fn(), select: vi.fn(), transaction: vi.fn() },
      userId: "00000000-0000-4000-8000-000000000002",
      scopes: ["health:read", "activity:read"],
      timezone: "UTC",
      sensorStore: { query: vi.fn() },
    });
    const scopedClient = new Client({ name: "default-series-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await scopedServer.connect(serverTransport);
    await scopedClient.connect(clientTransport);

    try {
      const result = await scopedClient.callTool({
        name: "get_recovery_training_series",
        arguments: { start_date: "2026-03-08", end_date: "2026-03-09" },
      });

      expect(result.isError).not.toBe(true);
      expect(mocks.listRange).toHaveBeenLastCalledWith(
        "2026-03-08",
        "2026-03-09",
        ["health", "sleep", "body_weight", "training_load", "activities"],
        { providers: [], modalities: [] },
      );
    } finally {
      await scopedClient.close();
      await scopedServer.close();
    }
  });

  it("bounds dense responses to 366 days", async () => {
    const result = await client.callTool({
      name: "get_recovery_training_series",
      arguments: { start_date: "2025-01-01", end_date: "2026-01-02" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]).toMatchObject({ type: "text" });
    if (result.content[0]?.type === "text") {
      expect(result.content[0].text).toContain("at most 366 inclusive days");
    }
    expect(mocks.listRange).not.toHaveBeenCalled();
  });

  it.each([
    { stream: "nutrition" as const, scope: "nutrition:read" as const },
    { stream: "activities" as const, scope: "activity:read" as const },
  ])(
    "allows a $stream-only request with only $scope and no ClickHouse",
    async ({ stream, scope }) => {
      const scopedServer = new McpServer({ name: `${stream}-series-test`, version: "1.0.0" });
      registerRecoveryTrainingSeriesTool(scopedServer, {
        db: { execute: vi.fn(), select: vi.fn(), transaction: vi.fn() },
        userId: "00000000-0000-4000-8000-000000000002",
        scopes: [scope],
        timezone: "UTC",
      });
      const scopedClient = new Client({ name: `${stream}-series-client`, version: "1.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await scopedServer.connect(serverTransport);
      await scopedClient.connect(clientTransport);
      mocks.listRange.mockResolvedValueOnce({
        range: { start_date: "2026-03-08", end_date: "2026-03-08", timezone: "UTC" },
        requested_streams: [stream],
        filters: { providers: [], modalities: [] },
        interpretation: {
          date_alignment: "Local calendar dates.",
          causality: "No causal claims.",
          filter_scope: "Filters apply to activity-derived streams.",
        },
        rows: [{ date: "2026-03-08" }],
      });

      try {
        const result = await scopedClient.callTool({
          name: "get_recovery_training_series",
          arguments: {
            start_date: "2026-03-08",
            end_date: "2026-03-08",
            streams: [stream],
          },
        });
        expect(result.isError).not.toBe(true);
      } finally {
        await scopedClient.close();
        await scopedServer.close();
      }
    },
  );

  it.each([
    { stream: "health" as const, scope: "health:read" as const },
    { stream: "sleep" as const, scope: "health:read" as const },
    { stream: "body_weight" as const, scope: "health:read" as const },
    { stream: "training_load" as const, scope: "activity:read" as const },
  ])("requires ClickHouse for the $stream stream", async ({ stream, scope }) => {
    const scopedServer = new McpServer({ name: `${stream}-missing-store`, version: "1.0.0" });
    registerRecoveryTrainingSeriesTool(scopedServer, {
      db: { execute: vi.fn(), select: vi.fn(), transaction: vi.fn() },
      userId: "00000000-0000-4000-8000-000000000002",
      scopes: [scope],
      timezone: "UTC",
    });
    const scopedClient = new Client({ name: `${stream}-missing-store-client`, version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await scopedServer.connect(serverTransport);
    await scopedClient.connect(clientTransport);

    try {
      const result = await scopedClient.callTool({
        name: "get_recovery_training_series",
        arguments: {
          start_date: "2026-03-08",
          end_date: "2026-03-08",
          streams: [stream],
        },
      });
      expect(result.isError).toBe(true);
      expect(result.content[0]).toMatchObject({
        type: "text",
        text: expect.stringContaining("requires the ClickHouse analytics store"),
      });
    } finally {
      await scopedClient.close();
      await scopedServer.close();
    }
  });
});
