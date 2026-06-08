import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMetricStreamEvent, type MetricStreamRowInput } from "./events.ts";
import type { MetricStreamBackfillBatch } from "./postgres-backfill-source.ts";
import type { MetricStreamArchiveObject } from "./r2-export.ts";
import {
  exportMetricStreamToR2,
  type MetricStreamWindowReader,
  parseMetricStreamR2ExportOptions,
  runMetricStreamR2ExportFromEnv,
  stepWindowsByUtcDay,
} from "./r2-export-run.ts";
import { parseMetricStreamArchiveObjectKey } from "./r2-replay.ts";

interface PutObjectInput {
  Bucket: string;
  Key: string;
  Body: Buffer;
}

// Mock the S3 SDK and the pg Client so the env-reading + wiring path
// (createR2ObjectPutter / run-from-env / cursor) is exercised without real
// connections. The module under test is imported statically, so the mock fns
// must come from vi.hoisted (it runs before the hoisted vi.mock factories).
const mocks = vi.hoisted(() => {
  const send = vi.fn();
  const destroy = vi.fn();
  const pgQuery = vi.fn();
  const pgConnect = vi.fn();
  const pgEnd = vi.fn();
  return {
    send,
    destroy,
    pgQuery,
    pgConnect,
    pgEnd,
    s3Client: vi.fn(() => ({ send, destroy })),
    putObjectCommand: vi.fn((input: PutObjectInput) => ({ command: "put", input })),
    pgClient: vi.fn(() => ({ connect: pgConnect, query: pgQuery, end: pgEnd })),
  };
});
vi.mock("@aws-sdk/client-s3", () => ({
  PutObjectCommand: mocks.putObjectCommand,
  S3Client: mocks.s3Client,
}));
vi.mock("pg", () => ({ Client: mocks.pgClient }));

function makeRowInput(overrides: Partial<MetricStreamRowInput>): MetricStreamRowInput {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    recordedAt: "2024-03-01T10:00:00.000Z",
    userId: "00000000-0000-0000-0000-000000000001",
    providerId: "apple_health",
    externalId: "hk:heart-rate-1",
    deviceId: "Apple Watch",
    sourceType: "api",
    channel: "heart_rate",
    scalar: 72,
    ...overrides,
  };
}

function batchOf(rows: MetricStreamRowInput[]): MetricStreamBackfillBatch {
  const last = rows[rows.length - 1];
  if (!last) {
    throw new Error("batchOf needs at least one row");
  }
  return { rows, cursor: { id: last.id ?? "missing", recordedAt: String(last.recordedAt) } };
}

/** A reader that yields the rows mapped to each window's UTC start day. */
function readerForDays(
  rowsByDay: Record<string, MetricStreamRowInput[]>,
): MetricStreamWindowReader {
  // biome-ignore lint/correctness/useYield: empty days legitimately yield nothing
  return async function* reader(window) {
    const day = window.start.toISOString().slice(0, 10);
    const rows = rowsByDay[day];
    if (rows && rows.length > 0) {
      yield batchOf(rows);
    }
  };
}

function decompressLines(body: Buffer): string[] {
  return gunzipSync(body).toString("utf8").split("\n");
}

describe("exportMetricStreamToR2", () => {
  it("archives every scanned row exactly once with the live archive's line format", async () => {
    const rows = [
      makeRowInput({ id: "10000000-0000-4000-8000-000000000001", externalId: "a" }),
      makeRowInput({
        id: "10000000-0000-4000-8000-000000000002",
        externalId: "b",
        recordedAt: "2024-03-01T10:00:01.000Z",
        scalar: 73,
      }),
    ];
    const putObject = vi.fn<(object: MetricStreamArchiveObject) => Promise<void>>(async () => {});

    const result = await exportMetricStreamToR2({
      batchSize: 100,
      concurrency: 8,
      end: new Date("2024-03-02T00:00:00.000Z"),
      maxObjectBytes: 10_000,
      putObject,
      start: new Date("2024-03-01T00:00:00.000Z"),
      streamWindow: readerForDays({ "2024-03-01": rows }),
    });

    expect(result.scanned).toBe(2);
    expect(result.objects).toBe(1);
    expect(result.lastCursor).toEqual({
      id: "10000000-0000-4000-8000-000000000002",
      recordedAt: "2024-03-01T10:00:01.000Z",
    });

    const archivedLines = putObject.mock.calls.flatMap(([object]) => decompressLines(object.body));
    expect(archivedLines).toHaveLength(2);
    const [firstCall] = putObject.mock.calls;
    if (!firstCall) {
      throw new Error("expected a PUT call");
    }
    const parsed = parseMetricStreamArchiveObjectKey(firstCall[0].key);
    expect(parsed.topic).toBe("metric-stream-v1");
    expect(parsed.partition).toBe(0);
    expect(parsed.date).toBe("2024-03-01");
    expect(parsed.hour).toBe("10");
    const expectedLines = rows.map((row) => JSON.stringify(createMetricStreamEvent(row)));
    expect(archivedLines.slice().sort()).toEqual(expectedLines.slice().sort());
  });

  it("steps multi-day ranges per UTC day, reading each day once", async () => {
    const reader = vi.fn(
      readerForDays({
        "2024-03-01": [
          makeRowInput({ id: "10000000-0000-4000-8000-000000000001", externalId: "d1" }),
        ],
        "2024-03-02": [
          makeRowInput({
            id: "10000000-0000-4000-8000-000000000002",
            externalId: "d2",
            recordedAt: "2024-03-02T10:00:00.000Z",
          }),
        ],
      }),
    );
    const putObject = vi.fn<(object: MetricStreamArchiveObject) => Promise<void>>(async () => {});

    const result = await exportMetricStreamToR2({
      batchSize: 100,
      concurrency: 8,
      end: new Date("2024-03-03T00:00:00.000Z"),
      maxObjectBytes: 10_000,
      putObject,
      start: new Date("2024-03-01T00:00:00.000Z"),
      streamWindow: reader,
    });

    expect(result.scanned).toBe(2);
    // One read per UTC day in [03-01, 03-03): 03-01 and 03-02.
    expect(reader).toHaveBeenCalledTimes(2);
    const archivedIds = putObject.mock.calls
      .flatMap(([object]) => decompressLines(object.body))
      .map((line) => JSON.parse(line).id)
      .sort();
    expect(archivedIds).toEqual([
      "10000000-0000-4000-8000-000000000001",
      "10000000-0000-4000-8000-000000000002",
    ]);
  });

  it("bounds PUT concurrency to the configured limit", async () => {
    const rows = Array.from({ length: 5 }, (_, index) =>
      makeRowInput({
        id: `10000000-0000-4000-8000-00000000000${index + 1}`,
        externalId: `evt-${index}`,
        recordedAt: `2024-03-01T1${index}:00:00.000Z`,
      }),
    );
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
      end: new Date("2024-03-02T00:00:00.000Z"),
      maxObjectBytes: 10_000,
      putObject,
      start: new Date("2024-03-01T00:00:00.000Z"),
      streamWindow: readerForDays({ "2024-03-01": rows }),
    });

    expect(result.objects).toBe(5);
    expect(maxInFlight).toBeLessThanOrEqual(2);
  });

  it("propagates a failed PUT instead of swallowing it", async () => {
    const putObject = vi.fn<(object: MetricStreamArchiveObject) => Promise<void>>(async () => {
      throw new Error("R2 unavailable");
    });

    await expect(
      exportMetricStreamToR2({
        batchSize: 100,
        concurrency: 8,
        end: new Date("2024-03-02T00:00:00.000Z"),
        maxObjectBytes: 10_000,
        putObject,
        start: new Date("2024-03-01T00:00:00.000Z"),
        streamWindow: readerForDays({ "2024-03-01": [makeRowInput({})] }),
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

describe("stepWindowsByUtcDay", () => {
  it("splits a multi-day range on UTC midnight boundaries", () => {
    const windows = [
      ...stepWindowsByUtcDay(
        new Date("2024-03-01T10:00:00.000Z"),
        new Date("2024-03-03T05:00:00.000Z"),
      ),
    ];
    expect(windows).toEqual([
      { start: new Date("2024-03-01T10:00:00.000Z"), end: new Date("2024-03-02T00:00:00.000Z") },
      { start: new Date("2024-03-02T00:00:00.000Z"), end: new Date("2024-03-03T00:00:00.000Z") },
      { start: new Date("2024-03-03T00:00:00.000Z"), end: new Date("2024-03-03T05:00:00.000Z") },
    ]);
  });

  it("yields a single window when start and end fall within one UTC day", () => {
    const windows = [
      ...stepWindowsByUtcDay(
        new Date("2024-03-01T00:00:00.000Z"),
        new Date("2024-03-02T00:00:00.000Z"),
      ),
    ];
    expect(windows).toEqual([
      { start: new Date("2024-03-01T00:00:00.000Z"), end: new Date("2024-03-02T00:00:00.000Z") },
    ]);
  });

  it("yields nothing when start is not before end", () => {
    expect([...stepWindowsByUtcDay(new Date("2024-03-02"), new Date("2024-03-01"))]).toEqual([]);
  });
});

describe("runMetricStreamR2ExportFromEnv", () => {
  const requiredEnv = {
    DATABASE_URL: "postgres://health:secret@db:5432/health",
    METRIC_STREAM_R2_BUCKET: "dofek-metric-stream-archive",
    R2_ENDPOINT: "https://example.r2.cloudflarestorage.com",
    R2_ACCESS_KEY_ID: "test-access-key",
    R2_SECRET_ACCESS_KEY: "test-secret-key",
  } as const;

  beforeEach(() => {
    mocks.send.mockReset().mockResolvedValue(undefined);
    mocks.destroy.mockClear();
    mocks.s3Client.mockClear();
    mocks.putObjectCommand.mockClear();
    mocks.pgClient.mockClear();
    mocks.pgConnect.mockReset().mockResolvedValue(undefined);
    mocks.pgEnd.mockReset().mockResolvedValue(undefined);
    mocks.pgQuery.mockReset();
    for (const [key, value] of Object.entries(requiredEnv)) {
      vi.stubEnv(key, value);
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("streams via the pg cursor and PUTs each archive object, then closes both clients", async () => {
    const fetchedRow = {
      id: "10000000-0000-4000-8000-000000000001",
      recorded_at: new Date("2026-05-15T10:00:00.000Z"),
      recorded_at_cursor: "2026-05-15 10:00:00+00",
      user_id: "00000000-0000-0000-0000-000000000001",
      provider_id: "apple_health",
      external_id: "imu-1",
      device_id: "Apple Watch",
      source_type: "api",
      channel: "imu",
      activity_id: null,
      scalar: null,
      vector: [0.1, 0.2, 0.3],
      point: null,
      metadata: null,
    };
    let fetchCount = 0;
    mocks.pgQuery.mockImplementation(async (text: string) => {
      if (text.startsWith("FETCH")) {
        fetchCount += 1;
        return { rows: fetchCount === 1 ? [fetchedRow] : [] };
      }
      return { rows: [] };
    });

    await runMetricStreamR2ExportFromEnv([
      "--start",
      "2026-05-15T00:00:00Z",
      "--end",
      "2026-05-16T00:00:00Z",
    ]);

    expect(mocks.pgConnect).toHaveBeenCalledTimes(1);
    expect(mocks.s3Client).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: requiredEnv.R2_ENDPOINT,
        region: "auto",
        credentials: {
          accessKeyId: requiredEnv.R2_ACCESS_KEY_ID,
          secretAccessKey: requiredEnv.R2_SECRET_ACCESS_KEY,
        },
      }),
    );
    expect(mocks.send).toHaveBeenCalledTimes(1);
    const putInput = mocks.putObjectCommand.mock.calls[0]?.[0];
    if (!putInput) {
      throw new Error("expected a PutObjectCommand call");
    }
    expect(putInput.Bucket).toBe(requiredEnv.METRIC_STREAM_R2_BUCKET);
    expect(putInput.Key).toMatch(/^metric-stream\/v1\/date=2026-05-15\/hour=10\//);
    // Both clients torn down so the one-shot exits.
    expect(mocks.destroy).toHaveBeenCalledTimes(1);
    expect(mocks.pgEnd).toHaveBeenCalledTimes(1);
  });

  it("fails loudly on a missing R2 env var before opening Postgres", async () => {
    vi.stubEnv("METRIC_STREAM_R2_BUCKET", "");

    await expect(
      runMetricStreamR2ExportFromEnv([
        "--start",
        "2026-05-15T00:00:00Z",
        "--end",
        "2026-05-16T00:00:00Z",
      ]),
    ).rejects.toThrow("METRIC_STREAM_R2_BUCKET environment variable is required");
    // R2 config is validated first, so no Postgres connection is opened.
    expect(mocks.pgClient).not.toHaveBeenCalled();
    expect(mocks.pgConnect).not.toHaveBeenCalled();
  });
});
