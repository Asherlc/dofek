import { describe, expect, it, vi } from "vitest";
import { createMetricStreamEvent, type MetricStreamRowInput } from "./events.ts";
import type { MetricStreamEventPublisher } from "./redpanda-producer.ts";
import { writeMetricStreamRows } from "./write-metric-stream.ts";

const metricStreamRow: MetricStreamRowInput = {
  recordedAt: "2026-06-06T19:00:00.000Z",
  userId: "00000000-0000-4000-8000-000000000001",
  providerId: "apple_health",
  externalId: "hk:heart-rate-1",
  deviceId: "Apple Watch",
  sourceType: "api",
  channel: "heart_rate",
  scalar: 72,
};
const metricStreamRows: MetricStreamRowInput[] = [metricStreamRow];
const operationRevision = "1000000000000000";

function makePublisher(): MetricStreamEventPublisher {
  return {
    publishRows: vi.fn(async (rows: readonly MetricStreamRowInput[], options) =>
      rows.map((row) => createMetricStreamEvent(row, options.operationRevision)),
    ),
  };
}

function makeDatabase(rows: readonly Record<string, unknown>[]) {
  const execute = vi
    .fn()
    .mockResolvedValueOnce([])
    .mockResolvedValueOnce([...rows]);
  const transaction = vi.fn(
    async <T>(work: (database: { execute: typeof execute }) => Promise<T>) => work({ execute }),
  );
  return { execute, transaction };
}

describe("writeMetricStreamRows", () => {
  it("returns without allocating a revision or publishing when there are no rows", async () => {
    const publisher = makePublisher();
    const database = { execute: vi.fn() };

    await expect(writeMetricStreamRows({ database, publisher, rows: [] })).resolves.toEqual({
      events: [],
      published: 0,
    });
    expect(database.execute).not.toHaveBeenCalled();
    expect(publisher.publishRows).not.toHaveBeenCalled();
  });

  it("publishes rows through the supplied Redpanda publisher", async () => {
    const publisher = makePublisher();
    const database = makeDatabase([
      {
        generation: "4",
        operation_revision: operationRevision,
        provider_id: "apple_health",
        user_id: metricStreamRow.userId,
      },
    ]);

    const result = await writeMetricStreamRows({
      database,
      publisher,
      rows: metricStreamRows,
    });

    expect(publisher.publishRows).toHaveBeenCalledWith(
      [expect.objectContaining({ generation: 4 })],
      { operationRevision },
    );
    expect(result.published).toBe(1);
    expect(result.events[0]?.channel).toBe("heart_rate");
    expect(result.events[0]?.generation).toBe(4);
  });

  it("loads the provider generation before publishing", async () => {
    const publisher = makePublisher();
    const database = makeDatabase([
      {
        generation: "0",
        operation_revision: operationRevision,
        provider_id: "apple_health",
        user_id: metricStreamRow.userId,
      },
    ]);

    await writeMetricStreamRows({
      database,
      publisher,
      rows: metricStreamRows,
    });

    expect(database.execute).toHaveBeenCalledTimes(2);
    expect(publisher.publishRows).toHaveBeenCalledTimes(1);
  });

  it("loads all provider generations in one authoritative query", async () => {
    const publisher = makePublisher();
    const database = makeDatabase([
      {
        generation: "4",
        operation_revision: operationRevision,
        provider_id: "apple_health",
        user_id: metricStreamRow.userId,
      },
      {
        generation: "2",
        operation_revision: operationRevision,
        provider_id: "garmin",
        user_id: metricStreamRow.userId,
      },
    ]);
    const garminRow: MetricStreamRowInput = {
      ...metricStreamRow,
      externalId: "garmin:heart-rate-1",
      providerId: "garmin",
    };

    await writeMetricStreamRows({
      database,
      publisher,
      rows: [...metricStreamRows, garminRow],
    });

    expect(database.execute).toHaveBeenCalledTimes(2);
    expect(publisher.publishRows).toHaveBeenCalledWith(
      [
        expect.objectContaining({ generation: 4, providerId: "apple_health" }),
        expect.objectContaining({ generation: 2, providerId: "garmin" }),
      ],
      { operationRevision },
    );
  });

  it("does not publish when a provider generation is unresolved", async () => {
    const publisher = makePublisher();
    const database = makeDatabase([
      {
        generation: "0",
        operation_revision: operationRevision,
        provider_id: "garmin",
        user_id: metricStreamRow.userId,
      },
    ]);

    await expect(
      writeMetricStreamRows({
        database,
        publisher,
        rows: metricStreamRows,
      }),
    ).rejects.toThrow("Provider data generation was not resolved");
    expect(publisher.publishRows).not.toHaveBeenCalled();
  });

  it("holds the account-erasure advisory transaction lock until publishing finishes", async () => {
    const publisher = makePublisher();
    let transactionFinished = false;
    vi.mocked(publisher.publishRows).mockImplementationOnce(async (rows, options) => {
      expect(transactionFinished).toBe(false);
      return rows.map((row) => createMetricStreamEvent(row, options.operationRevision));
    });
    const database = makeDatabase([
      {
        generation: "0",
        operation_revision: operationRevision,
        provider_id: "apple_health",
        user_id: metricStreamRow.userId,
      },
    ]);
    database.transaction.mockImplementationOnce(async (work) => {
      const result = await work({ execute: database.execute });
      transactionFinished = true;
      return result;
    });

    await writeMetricStreamRows({ database, publisher, rows: metricStreamRows });

    expect(database.transaction).toHaveBeenCalledTimes(1);
    expect(transactionFinished).toBe(true);
  });

  it("does not publish when the database account-erasure fence rejects the user", async () => {
    const publisher = makePublisher();
    const database = makeDatabase([]);
    database.execute.mockReset();
    database.execute.mockRejectedValueOnce(
      new Error(`Account erasure is active for user ${metricStreamRow.userId}`),
    );

    await expect(
      writeMetricStreamRows({ database, publisher, rows: metricStreamRows }),
    ).rejects.toThrow("Account erasure is active");
    expect(publisher.publishRows).not.toHaveBeenCalled();
  });
});
