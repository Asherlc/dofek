import type { IncomingHttpHeaders } from "node:http";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { Duplex } from "node:stream";
import { PgDialect } from "drizzle-orm/pg-core";
import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const routeMocks = vi.hoisted(() => ({
  captureException: vi.fn<(error: unknown) => void>(),
  executeWithSchema: vi.fn<
    (...args: unknown[]) => Promise<Array<{ id: string; externalId?: string }>>
  >(async () => []),
  invalidateAllUserQueries: vi.fn<(userId: string) => Promise<void>>(async () => undefined),
  loggerError: vi.fn<(message: string) => void>(),
  loggerWarn: vi.fn<(message: string) => void>(),
  validateCompanionToken: vi.fn<(_db: unknown, token: string) => Promise<string | null>>(),
  writeMetricStreamBatch: vi.fn<(...args: unknown[]) => Promise<number>>(async () => 0),
  writeMetricStreamRows: vi.fn<
    (...args: unknown[]) => Promise<{ events: unknown[]; published: number }>
  >(async () => ({ events: [], published: 0 })),
}));

vi.mock("@sentry/node", () => ({
  captureException: routeMocks.captureException,
}));

vi.mock("../companion/token-repository.ts", () => ({
  validateCompanionToken: routeMocks.validateCompanionToken,
}));

vi.mock("../lib/typed-sql.ts", () => ({
  executeWithSchema: routeMocks.executeWithSchema,
}));

vi.mock("dofek/lib/cache", () => ({
  invalidateAllUserQueries: routeMocks.invalidateAllUserQueries,
}));

vi.mock("../logger.ts", () => ({
  logger: {
    error: routeMocks.loggerError,
    warn: routeMocks.loggerWarn,
  },
}));

vi.mock("../../../../src/db/metric-stream-writer.ts", () => ({
  writeMetricStreamBatch: routeMocks.writeMetricStreamBatch,
}));

vi.mock("../../../../src/metric-stream/write-metric-stream.ts", () => ({
  writeMetricStreamRows: routeMocks.writeMetricStreamRows,
}));

import { createIngestZosHealthRouter } from "./ingest-zos-health.ts";

const userId = "00000000-0000-0000-0000-000000000001";

type InsertedValues = Record<string, unknown>;

function createMockDatabase(
  options: { executeError?: Error; insertedSleepSessionId?: string } = {},
) {
  const insertedValues: InsertedValues[] = [];
  const execute = vi.fn<(_query: unknown) => Promise<Array<Record<string, unknown>>>>(async () => {
    if (options.executeError) {
      throw options.executeError;
    }
    return [];
  });
  const insert = vi.fn((_table: unknown) => ({
    values: vi.fn((values: InsertedValues) => {
      insertedValues.push(values);
      return {
        onConflictDoNothing: vi.fn(() => ({
          returning: vi.fn(async () =>
            options.insertedSleepSessionId === undefined
              ? []
              : [{ id: options.insertedSleepSessionId }],
          ),
        })),
      };
    }),
  }));
  const db = { execute, insert } satisfies import("dofek/db").Database;
  return { db, execute, insert, insertedValues };
}

function createTestApp(
  db: import("dofek/db").Database,
  metricStreamPublisher?: import("../../../../src/metric-stream/redpanda-producer.ts").MetricStreamEventPublisher,
) {
  const app = express();
  app.use("/api/ingest", createIngestZosHealthRouter({ db, metricStreamPublisher }));
  return app;
}

class InProcessSocket extends Duplex {
  readonly #chunks: Buffer[] = [];

  get responseBody(): string {
    const rawResponse = Buffer.concat(this.#chunks).toString("utf8");
    const bodyStart = rawResponse.indexOf("\r\n\r\n");
    if (bodyStart === -1) {
      throw new Error("Response body separator was not found");
    }
    return rawResponse.slice(bodyStart + 4);
  }

  override _write(
    chunk: Buffer | string,
    encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.#chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    callback();
  }
}

class InProcessRequest extends IncomingMessage {
  override headers: IncomingHttpHeaders;
  override method: string;
  override url: string;

  constructor(socket: Socket, payload: string, headers: IncomingHttpHeaders) {
    super(socket);
    this.headers = headers;
    this.method = "POST";
    this.url = "/api/ingest/zos-health";
    this.push(payload);
    this.push(null);
  }

  override _read(): void {}
}

async function post(
  app: express.Express,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; body: unknown }> {
  const payload = JSON.stringify(body);
  const socket = new InProcessSocket();
  const request = new InProcessRequest(new Socket(), payload, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload).toString(),
    ...headers,
  });

  const response: ServerResponse = Reflect.construct(ServerResponse, [request]);
  Reflect.apply(response.assignSocket, response, [socket]);

  return new Promise((resolve, reject) => {
    response.on("finish", () => {
      resolve({
        status: response.statusCode,
        body: JSON.parse(socket.responseBody),
      });
    });
    response.on("error", reject);
    request.on("error", reject);

    Reflect.apply(app.handle, app, [
      request,
      response,
      (error: unknown) => {
        reject(error instanceof Error ? error : new Error("Request was not handled"));
      },
    ]);
  });
}

describe("createIngestZosHealthRouter", () => {
  beforeEach(() => {
    routeMocks.captureException.mockReset();
    routeMocks.executeWithSchema.mockReset();
    routeMocks.executeWithSchema.mockResolvedValue([]);
    routeMocks.invalidateAllUserQueries.mockReset();
    routeMocks.invalidateAllUserQueries.mockResolvedValue(undefined);
    routeMocks.loggerError.mockReset();
    routeMocks.loggerWarn.mockReset();
    routeMocks.validateCompanionToken.mockReset();
    routeMocks.validateCompanionToken.mockResolvedValue(userId);
    routeMocks.writeMetricStreamBatch.mockReset();
    routeMocks.writeMetricStreamBatch.mockResolvedValue(0);
    routeMocks.writeMetricStreamRows.mockReset();
    routeMocks.writeMetricStreamRows.mockResolvedValue({ events: [], published: 0 });
  });

  it("returns 401 when the bearer token is missing", async () => {
    const { db, execute, insert } = createMockDatabase();

    const response = await post(createTestApp(db), {});

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "Dofek connection is required." });
    expect(routeMocks.validateCompanionToken).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("returns 401 when the companion token is invalid", async () => {
    routeMocks.validateCompanionToken.mockResolvedValue(null);
    const { db, execute, insert } = createMockDatabase();

    const response = await post(createTestApp(db), {}, { authorization: "Bearer invalid-token" });

    expect(response.status).toBe(401);
    expect(response.body).toEqual({ error: "Invalid or revoked Dofek connection." });
    expect(routeMocks.validateCompanionToken).toHaveBeenCalledWith(db, "invalid-token");
    expect(execute).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("returns 500 when token validation fails", async () => {
    const validationError = new Error("token repository unavailable");
    routeMocks.validateCompanionToken.mockRejectedValue(validationError);
    const { db, execute } = createMockDatabase();

    const response = await post(createTestApp(db), {}, { authorization: "Bearer token-123" });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Failed to validate Dofek connection." });
    expect(routeMocks.captureException).toHaveBeenCalledWith(validationError);
    expect(routeMocks.loggerError).toHaveBeenCalledWith(
      `[ingest-zos] Token validation failed: ${validationError}`,
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns 400 when the payload has no ingest sections", async () => {
    const { db, execute, insert } = createMockDatabase();

    const response = await post(createTestApp(db), {}, { authorization: "Bearer token-123" });

    expect(response.status).toBe(400);
    expect(response.body).toEqual({
      error:
        "At least one of dailyMetrics, sleepSessions, activities, backgroundSamples, liveWorkoutSamples, or watchSummary is required.",
    });
    expect(execute).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("retains the watch's daily summary and timestamped sensor history", async () => {
    const { db, execute } = createMockDatabase();

    const response = await post(
      createTestApp(db, { publishRows: vi.fn(async () => []) }),
      {
        watchSummary: {
          collectedAt: 1_720_001_200_000,
          date: "2024-07-03",
          timezoneOffsetMinutes: -120,
          steps: 4321,
          standHours: 8,
          fatBurning: 22,
          heartRate: [0, 61, 62],
          bodyTemperature: [35.1, -1000, 35.3],
          stress: [0, 18, 20],
          spo2Recent: [{ spo2: 98, time: 1_720_001_100 }],
          restingHeartRate: 55,
          stepsTarget: 10_000,
          distance: 6543,
          bloodOxygenCurrent: 97,
          bodyTemperatureCurrent: 35.4,
          pai: 86,
        },
      },
      { authorization: "Bearer token-123" },
    );

    expect(response.status).toBe(200);
    expect(routeMocks.invalidateAllUserQueries).toHaveBeenCalledWith(userId);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(routeMocks.writeMetricStreamRows).toHaveBeenCalledWith(
      expect.objectContaining({
        database: db,
        rows: expect.arrayContaining([
          expect.objectContaining({
            recordedAt: "2024-07-02T22:01:00.000Z",
            channel: "heart_rate",
            scalar: 61,
          }),
          expect.objectContaining({
            recordedAt: "2024-07-02T22:10:00.000Z",
            channel: "skin_temperature",
            scalar: 35.3,
          }),
          expect.objectContaining({
            recordedAt: "2024-07-02T22:02:00.000Z",
            channel: "stress",
            scalar: 20,
          }),
          expect.objectContaining({
            recordedAt: "2024-07-03T10:05:00.000Z",
            channel: "spo2",
            scalar: 0.98,
          }),
          expect.objectContaining({ channel: "zepp_daily_steps_target", scalar: 10_000 }),
          expect.objectContaining({ channel: "zepp_daily_distance", scalar: 6543 }),
          expect.objectContaining({ channel: "zepp_pai", scalar: 86 }),
        ]),
      }),
    );
  });

  it("returns 400 when the payload shape is invalid", async () => {
    const { db, execute, insert } = createMockDatabase();

    const response = await post(
      createTestApp(db),
      { dailyMetrics: "not-a-record" },
      { authorization: "Bearer token-123" },
    );

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ error: "Invalid payload" });
    expect(execute).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("publishes background health samples to the metric stream", async () => {
    const { db } = createMockDatabase();
    const metricStreamPublisher = {
      publishRows: vi.fn(async () => []),
    } satisfies import("../../../../src/metric-stream/redpanda-producer.ts").MetricStreamEventPublisher;

    const response = await post(
      createTestApp(db, metricStreamPublisher),
      {
        backgroundSamples: [
          {
            recordedAt: "2024-07-03T10:48:20.000Z",
            heartRate: 72,
            bloodOxygenPercent: 98,
            bodyTemperatureCelsius: 36.6,
            stress: 35,
          },
        ],
      },
      { authorization: "Bearer token-123" },
    );

    expect(response.status).toBe(200);
    expect(routeMocks.writeMetricStreamBatch).toHaveBeenCalledWith(
      db,
      [
        {
          recordedAt: new Date("2024-07-03T10:48:20.000Z"),
          providerId: "amazfit-zepp",
          userId,
          externalId: "zepp-background-2024-07-03T10:48:20.000Z",
          sourceName: "zepp-companion-background",
          heartRate: 72,
          spo2: 0.98,
          temperatureC: 36.6,
          stress: 35,
        },
      ],
      "api",
      undefined,
      metricStreamPublisher,
    );
  });

  it("retains every live workout metric as an activity-linked metric-stream row", async () => {
    routeMocks.executeWithSchema.mockResolvedValue([
      {
        id: "00000000-0000-4000-8000-000000000002",
        externalId: "1720000000",
      },
    ]);
    const { db } = createMockDatabase();
    const metricStreamPublisher = {
      publishRows: vi.fn(async () => []),
    } satisfies import("../../../../src/metric-stream/redpanda-producer.ts").MetricStreamEventPublisher;

    const response = await post(
      createTestApp(db, metricStreamPublisher),
      {
        activities: [
          {
            externalId: "1720000000",
            activityType: "other",
            startedAt: "2024-07-03T09:46:40.000Z",
            endedAt: "2024-07-03T10:46:40.000Z",
          },
        ],
        liveWorkoutSamples: [
          {
            externalId: "1720000000",
            recordedAt: "2024-07-03T09:51:52.000Z",
            heartRate: 148,
            metrics: { speed: 3.5, distance: 1000, duration: 312 },
          },
          {
            externalId: "1720000000",
            recordedAt: "2024-07-03T09:52:02.000Z",
            metrics: { duration: 322 },
          },
        ],
      },
      { authorization: "Bearer token-123" },
    );

    expect(response.status).toBe(200);
    expect(routeMocks.executeWithSchema).toHaveBeenCalledOnce();
    expect(routeMocks.writeMetricStreamRows).toHaveBeenCalledWith({
      database: db,
      publisher: metricStreamPublisher,
      rows: expect.arrayContaining([
        expect.objectContaining({
          activityId: "00000000-0000-4000-8000-000000000002",
          channel: "heart_rate",
          scalar: 148,
        }),
        expect.objectContaining({ channel: "zepp_sport_speed", scalar: 3.5 }),
        expect.objectContaining({ channel: "zepp_sport_distance", scalar: 1000 }),
        expect.objectContaining({ channel: "zepp_sport_duration", scalar: 312 }),
      ]),
    });
  });

  it("reports a missing activity for live workout samples", async () => {
    routeMocks.executeWithSchema.mockResolvedValue([]);
    const { db } = createMockDatabase();
    const metricStreamPublisher = {
      publishRows: vi.fn(async () => []),
    } satisfies import("../../../../src/metric-stream/redpanda-producer.ts").MetricStreamEventPublisher;

    const response = await post(
      createTestApp(db, metricStreamPublisher),
      {
        liveWorkoutSamples: [
          {
            externalId: "missing-activity",
            recordedAt: "2024-07-03T09:51:52.000Z",
            metrics: { duration: 312 },
          },
        ],
      },
      { authorization: "Bearer token-123" },
    );

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Failed to ingest health data." });
    const capturedError = routeMocks.captureException.mock.calls[0]?.[0];
    expect(capturedError).toEqual(
      new Error("Zepp live workout activity missing-activity was not found."),
    );
    expect(metricStreamPublisher.publishRows).not.toHaveBeenCalled();
  });

  it("stores daily metrics, sleep sessions with stages, and activities for a valid payload", async () => {
    const { db, execute, insertedValues } = createMockDatabase({
      insertedSleepSessionId: "sleep-session-1",
    });

    const response = await post(
      createTestApp(db),
      {
        dailyMetrics: {
          "2026-06-28": {
            steps: 12_345,
            distanceKm: 8.7,
            standHours: 11,
            spo2Avg: 97.2,
            skinTempC: 35.9,
            stressHighMinutes: 21,
            exerciseMinutes: 44,
          },
        },
        sleepSessions: [
          {
            externalId: "sleep-1",
            startedAt: "2026-06-27T22:30:00Z",
            endedAt: "2026-06-28T06:30:00Z",
            durationMinutes: 480,
            deepMinutes: 90,
            remMinutes: 100,
            lightMinutes: 250,
            awakeMinutes: 40,
            efficiencyPct: 91.5,
            stages: [
              {
                stage: "deep",
                startedAt: "2026-06-27T23:00:00Z",
                endedAt: "2026-06-28T00:15:00Z",
              },
            ],
          },
        ],
        activities: [
          {
            externalId: "activity-1",
            activityType: "running",
            startedAt: "2026-06-28T14:00:00Z",
            endedAt: "2026-06-28T15:00:00Z",
            name: "Lunch Run",
          },
        ],
      },
      { authorization: "Bearer token-123" },
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
    expect(routeMocks.validateCompanionToken).toHaveBeenCalledWith(db, "token-123");
    expect(execute).toHaveBeenCalledTimes(3);
    const dailyMetricsQuery = new PgDialect().sqlToQuery(execute.mock.calls[1]?.[0]);
    expect(dailyMetricsQuery.params).toEqual([
      "2026-06-28",
      "amazfit-zepp",
      userId,
      12_345,
      8.7,
      11,
      97.2,
      35.9,
      21,
      44,
    ]);
    expect(routeMocks.executeWithSchema).toHaveBeenCalledOnce();
    expect(insertedValues).toHaveLength(2);
    expect(insertedValues[0]).toMatchObject({
      providerId: "amazfit-zepp",
      userId,
      externalId: "sleep-1",
      durationMinutes: 480,
      deepMinutes: 90,
      remMinutes: 100,
      lightMinutes: 250,
      awakeMinutes: 40,
      efficiencyPct: 91.5,
      stagingAvailable: true,
      sourceName: "zepp-companion",
    });
    expect(insertedValues[0]?.startedAt).toEqual(new Date("2026-06-27T22:30:00Z"));
    expect(insertedValues[0]?.endedAt).toEqual(new Date("2026-06-28T06:30:00Z"));
    expect(insertedValues[1]).toMatchObject({
      sessionId: "sleep-session-1",
      stage: "deep",
      sourceName: "zepp-companion",
    });
    expect(insertedValues[1]?.startedAt).toEqual(new Date("2026-06-27T23:00:00Z"));
    expect(insertedValues[1]?.endedAt).toEqual(new Date("2026-06-28T00:15:00Z"));
  });

  it.each(["deepMinutes", "remMinutes", "lightMinutes", "awakeMinutes"] as const)(
    "marks staging unavailable when %s is absent",
    async (missingStage) => {
      const { db, insertedValues } = createMockDatabase();
      const completeStages = {
        deepMinutes: 90,
        remMinutes: 100,
        lightMinutes: 250,
        awakeMinutes: 40,
      };

      const response = await post(
        createTestApp(db),
        {
          sleepSessions: [
            {
              externalId: `sleep-missing-${missingStage}`,
              startedAt: "2026-06-27T22:30:00Z",
              endedAt: "2026-06-28T06:30:00Z",
              ...completeStages,
              [missingStage]: undefined,
            },
          ],
        },
        { authorization: "Bearer token-123" },
      );

      expect(response.status).toBe(200);
      expect(insertedValues[0]).toMatchObject({ stagingAvailable: false });
    },
  );

  it("uses an existing sleep session id when the sleep session insert conflicts", async () => {
    routeMocks.executeWithSchema.mockResolvedValue([{ id: "existing-sleep-session" }]);
    const { db, insertedValues } = createMockDatabase();

    const response = await post(
      createTestApp(db),
      {
        sleepSessions: [
          {
            externalId: "sleep-duplicate",
            startedAt: "2026-06-27T22:30:00Z",
            endedAt: "2026-06-28T06:30:00Z",
            stages: [
              {
                stage: "rem",
                startedAt: "2026-06-28T04:00:00Z",
                endedAt: "2026-06-28T04:45:00Z",
              },
            ],
          },
        ],
      },
      { authorization: "Bearer token-123" },
    );

    expect(response.status).toBe(200);
    expect(insertedValues[1]).toMatchObject({
      sessionId: "existing-sleep-session",
      stage: "rem",
    });
  });

  it("skips daily metrics with invalid date keys", async () => {
    const { db, execute } = createMockDatabase();

    const response = await post(
      createTestApp(db),
      {
        dailyMetrics: {
          "not-a-date": { steps: 12_345 },
          "2026-06-28": { steps: 9_876 },
        },
      },
      { authorization: "Bearer token-123" },
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: "ok" });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(routeMocks.loggerWarn).toHaveBeenCalledWith(
      "[ingest-zos] Invalid date: not-a-date, skipping",
    );
  });

  it("returns 500 when ingest persistence fails", async () => {
    const ingestError = new Error("database unavailable");
    const { db } = createMockDatabase({ executeError: ingestError });

    const response = await post(
      createTestApp(db),
      { dailyMetrics: { "2026-06-28": { steps: 12_345 } } },
      { authorization: "Bearer token-123" },
    );

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Failed to ingest health data." });
    const ensureError = expect.objectContaining({
      message: expect.stringContaining("ensureProvider(amazfit-zepp) failed"),
      cause: ingestError,
    });
    expect(routeMocks.captureException).toHaveBeenCalledWith(ensureError);
    expect(routeMocks.loggerError).toHaveBeenCalledWith(
      expect.stringContaining("[ingest-zos] Failed to ingest health data: Error: ensureProvider"),
    );
  });
});
