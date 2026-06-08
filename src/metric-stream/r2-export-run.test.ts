import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMetricStreamEvent } from "./events.ts";
import type { PostgresMetricStreamBackfillDatabase } from "./postgres-backfill-source.ts";
import type { MetricStreamArchiveObject } from "./r2-export.ts";
import {
  exportMetricStreamToR2,
  parseMetricStreamR2ExportOptions,
  runMetricStreamR2ExportFromEnv,
} from "./r2-export-run.ts";
import { parseMetricStreamArchiveObjectKey } from "./r2-replay.ts";

interface PutObjectInput {
  Bucket: string;
  Key: string;
  Body: Buffer;
}

// Mock the S3 SDK and the DB factory so the env-reading + client-wiring path
// (createR2ObjectPutter / run-from-env) is exercised without a real connection.
// The module under test is imported statically, so the mock fns must come from
// vi.hoisted — which runs before the hoisted vi.mock factories and imports.
const mocks = vi.hoisted(() => {
  const send = vi.fn();
  return {
    send,
    s3Client: vi.fn(() => ({ send })),
    putObjectCommand: vi.fn((input: PutObjectInput) => ({ command: "put", input })),
    createDatabaseFromEnv: vi.fn(),
  };
});
vi.mock("@aws-sdk/client-s3", () => ({
  PutObjectCommand: mocks.putObjectCommand,
  S3Client: mocks.s3Client,
}));
vi.mock("../db/index.ts", () => ({
  createDatabaseFromEnv: mocks.createDatabaseFromEnv,
}));

function makeDatabaseRow(overrides: Record<string, unknown>) {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    recorded_at: new Date("2024-03-01T10:00:00.000Z"),
    user_id: "00000000-0000-0000-0000-000000000001",
    provider_id: "apple_health",
    external_id: "hk:heart-rate-1",
    device_id: "Apple Watch",
    source_type: "api",
    channel: "heart_rate",
    activity_id: null,
    scalar: 72,
    vector: null,
    point: null,
    metadata: null,
    ...overrides,
  };
}

function decompressLines(body: Buffer): string[] {
  return gunzipSync(body).toString("utf8").split("\n");
}

describe("exportMetricStreamToR2", () => {
  it("archives every scanned row exactly once with the live archive's line format", async () => {
    const databaseRows = [
      makeDatabaseRow({ id: "10000000-0000-4000-8000-000000000001", external_id: "a" }),
      makeDatabaseRow({
        id: "10000000-0000-4000-8000-000000000002",
        external_id: "b",
        recorded_at: new Date("2024-03-01T10:00:01.000Z"),
        scalar: 73,
      }),
    ];
    const execute = vi
      .fn<PostgresMetricStreamBackfillDatabase["execute"]>()
      .mockResolvedValueOnce(databaseRows)
      .mockResolvedValueOnce([]);
    const putObject = vi.fn<(object: MetricStreamArchiveObject) => Promise<void>>(async () => {});

    const result = await exportMetricStreamToR2({
      batchSize: 100,
      concurrency: 8,
      db: { execute },
      end: new Date("2024-03-02T00:00:00.000Z"),
      maxObjectBytes: 10_000,
      putObject,
      start: new Date("2024-03-01T00:00:00.000Z"),
    });

    expect(result.scanned).toBe(2);
    expect(result.objects).toBe(1);
    expect(result.lastCursor).toEqual({
      id: "10000000-0000-4000-8000-000000000002",
      recordedAt: "2024-03-01T10:00:01.000Z",
    });

    // Each archived line is exactly the producer's serialized event for that
    // row (byte-identical archive format is proven in r2-export.test.ts); here
    // we assert every scanned row is archived once and keeps its Postgres id.
    const archivedLines = putObject.mock.calls.flatMap(([object]) => decompressLines(object.body));
    expect(archivedLines).toHaveLength(2);
    // The single object is keyed for the live single-partition topic under the
    // event's date/hour — proves the chunker is wired with the archive topic.
    const [firstCall] = putObject.mock.calls;
    if (!firstCall) {
      throw new Error("expected a PUT call");
    }
    const parsed = parseMetricStreamArchiveObjectKey(firstCall[0].key);
    expect(parsed.topic).toBe("metric-stream-v1");
    expect(parsed.partition).toBe(0);
    expect(parsed.date).toBe("2024-03-01");
    expect(parsed.hour).toBe("10");
    const expectedLines = databaseRows.map((row) =>
      JSON.stringify(
        createMetricStreamEvent({
          id: row.id,
          recordedAt: new Date(row.recorded_at).toISOString(),
          userId: row.user_id,
          providerId: row.provider_id,
          externalId: row.external_id,
          deviceId: row.device_id,
          sourceType: row.source_type,
          channel: row.channel,
          scalar: row.scalar,
        }),
      ),
    );
    expect(archivedLines.slice().sort()).toEqual(expectedLines.slice().sort());
  });

  it("bounds PUT concurrency to the configured limit", async () => {
    const databaseRows = Array.from({ length: 5 }, (_, index) =>
      makeDatabaseRow({
        id: `10000000-0000-4000-8000-00000000000${index + 1}`,
        external_id: `evt-${index}`,
        recorded_at: new Date(`2024-03-01T1${index}:00:00.000Z`),
      }),
    );
    const execute = vi
      .fn<PostgresMetricStreamBackfillDatabase["execute"]>()
      .mockResolvedValueOnce(databaseRows)
      .mockResolvedValueOnce([]);

    let inFlight = 0;
    let maxInFlight = 0;
    const putObject = vi.fn<(object: MetricStreamArchiveObject) => Promise<void>>(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
    });

    const result = await exportMetricStreamToR2({
      batchSize: 100,
      concurrency: 2,
      db: { execute },
      end: new Date("2024-03-02T00:00:00.000Z"),
      // One object per hour bucket; five hours => five objects.
      maxObjectBytes: 10_000,
      putObject,
      start: new Date("2024-03-01T00:00:00.000Z"),
    });

    expect(result.objects).toBe(5);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it("propagates a failed PUT instead of swallowing it", async () => {
    const execute = vi
      .fn<PostgresMetricStreamBackfillDatabase["execute"]>()
      .mockResolvedValueOnce([makeDatabaseRow({})])
      .mockResolvedValueOnce([]);
    const putObject = vi.fn<(object: MetricStreamArchiveObject) => Promise<void>>(async () => {
      throw new Error("R2 unavailable");
    });

    await expect(
      exportMetricStreamToR2({
        batchSize: 100,
        concurrency: 8,
        db: { execute },
        end: new Date("2024-03-02T00:00:00.000Z"),
        maxObjectBytes: 10_000,
        putObject,
        start: new Date("2024-03-01T00:00:00.000Z"),
      }),
    ).rejects.toThrow("R2 unavailable");
  });
});

describe("parseMetricStreamR2ExportOptions", () => {
  it("defaults object size and concurrency when the flags are absent", () => {
    const options = parseMetricStreamR2ExportOptions([
      "--start",
      "2024-01-01T00:00:00Z",
      "--end",
      "2024-02-01T00:00:00Z",
    ]);
    expect(options.maxObjectBytes).toBe(8_000_000);
    expect(options.concurrency).toBe(16);
    expect(options.start).toEqual(new Date("2024-01-01T00:00:00Z"));
  });

  it("reads the export-only flags and still parses the window flags", () => {
    const options = parseMetricStreamR2ExportOptions([
      "--start",
      "2024-01-01T00:00:00Z",
      "--end",
      "2024-02-01T00:00:00Z",
      "--max-object-bytes",
      "4000000",
      "--concurrency",
      "32",
      "--batch-size",
      "2000",
    ]);
    expect(options.maxObjectBytes).toBe(4_000_000);
    expect(options.concurrency).toBe(32);
    expect(options.batchSize).toBe(2000);
  });

  it("rejects a non-positive concurrency", () => {
    expect(() =>
      parseMetricStreamR2ExportOptions([
        "--start",
        "2024-01-01T00:00:00Z",
        "--end",
        "2024-02-01T00:00:00Z",
        "--concurrency",
        "0",
      ]),
    ).toThrow("--concurrency must be a positive integer");
  });
});

describe("runMetricStreamR2ExportFromEnv", () => {
  const requiredR2Env = {
    METRIC_STREAM_R2_BUCKET: "dofek-metric-stream-archive",
    R2_ENDPOINT: "https://example.r2.cloudflarestorage.com",
    R2_ACCESS_KEY_ID: "test-access-key",
    R2_SECRET_ACCESS_KEY: "test-secret-key",
  } as const;

  beforeEach(() => {
    mocks.send.mockReset().mockResolvedValue(undefined);
    mocks.s3Client.mockClear();
    mocks.putObjectCommand.mockClear();
    mocks.createDatabaseFromEnv.mockReset();
    for (const [key, value] of Object.entries(requiredR2Env)) {
      vi.stubEnv(key, value);
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds the R2 client from env and PUTs each archive object to the configured bucket", async () => {
    const execute = vi
      .fn<PostgresMetricStreamBackfillDatabase["execute"]>()
      .mockResolvedValueOnce([
        {
          id: "10000000-0000-4000-8000-000000000001",
          recorded_at: new Date("2024-03-01T10:00:00.000Z"),
          user_id: "00000000-0000-0000-0000-000000000001",
          provider_id: "apple_health",
          external_id: "hk:hr-1",
          device_id: "Apple Watch",
          source_type: "api",
          channel: "heart_rate",
          activity_id: null,
          scalar: 72,
          vector: null,
          point: null,
          metadata: null,
        },
      ])
      .mockResolvedValueOnce([]);
    mocks.createDatabaseFromEnv.mockReturnValue({ execute });

    await runMetricStreamR2ExportFromEnv([
      "--start",
      "2024-03-01T00:00:00Z",
      "--end",
      "2024-03-02T00:00:00Z",
    ]);

    expect(mocks.s3Client).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: requiredR2Env.R2_ENDPOINT,
        region: "auto",
        credentials: {
          accessKeyId: requiredR2Env.R2_ACCESS_KEY_ID,
          secretAccessKey: requiredR2Env.R2_SECRET_ACCESS_KEY,
        },
      }),
    );
    expect(mocks.send).toHaveBeenCalledTimes(1);
    const putInput = mocks.putObjectCommand.mock.calls[0]?.[0];
    if (!putInput) {
      throw new Error("expected a PutObjectCommand call");
    }
    expect(putInput.Bucket).toBe(requiredR2Env.METRIC_STREAM_R2_BUCKET);
    expect(putInput.Key).toMatch(/^metric-stream\/v1\/date=2024-03-01\/hour=10\//);
    expect(Buffer.isBuffer(putInput.Body)).toBe(true);
  });

  it("fails loudly when a required R2 env var is missing", async () => {
    vi.stubEnv("METRIC_STREAM_R2_BUCKET", "");
    mocks.createDatabaseFromEnv.mockReturnValue({ execute: vi.fn() });

    await expect(
      runMetricStreamR2ExportFromEnv([
        "--start",
        "2024-03-01T00:00:00Z",
        "--end",
        "2024-03-02T00:00:00Z",
      ]),
    ).rejects.toThrow("METRIC_STREAM_R2_BUCKET environment variable is required");
  });
});
