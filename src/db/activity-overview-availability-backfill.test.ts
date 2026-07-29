import { describe, expect, it, type Mock, vi } from "vitest";
import { backfillActivityOverviewAvailability } from "./activity-overview-availability-backfill.ts";
import type { ClickHouseClient } from "./clickhouse.ts";

const RANGE = {
  start: new Date("2026-03-01T00:00:00Z"),
  end: new Date("2026-04-01T00:00:00Z"),
};

function createMockClickHouseClient(query: Mock, command: Mock): ClickHouseClient {
  return { command, query };
}

function createClient(counts: readonly number[]): {
  client: ClickHouseClient;
  command: Mock;
  query: Mock;
} {
  let countIndex = 0;
  const query = vi.fn(async () => ({
    json: async () => {
      const count = counts[countIndex];
      countIndex += 1;
      return count === undefined ? [] : [{ candidate_count: count }];
    },
  }));
  const command = vi.fn(async () => undefined);
  return {
    client: createMockClickHouseClient(query, command),
    command,
    query,
  };
}

describe("backfillActivityOverviewAvailability", () => {
  it("counts distance and elevation without writing during a dry run", async () => {
    const { client, command, query } = createClient([2, 3]);

    await expect(
      backfillActivityOverviewAvailability(client, { ...RANGE, execute: false }),
    ).resolves.toEqual({
      distanceRows: 2,
      elevationRows: 3,
    });

    expect(query).toHaveBeenCalledTimes(2);
    expect(query.mock.calls[0]?.[0]).toMatchObject({
      format: "JSONEachRow",
      query_params: {
        start: "2026-03-01T00:00:00.000Z",
        end: "2026-04-01T00:00:00.000Z",
      },
    });
    expect(command).not.toHaveBeenCalled();
  });

  it("writes each nonempty measurement candidate set independently", async () => {
    const { client, command } = createClient([2, 0]);

    await expect(
      backfillActivityOverviewAvailability(client, { ...RANGE, execute: true }),
    ).resolves.toEqual({
      distanceRows: 2,
      elevationRows: 0,
    });

    expect(command).toHaveBeenCalledOnce();
    expect(command.mock.calls[0]?.[0]).toMatchObject({
      clickhouse_settings: { wait_end_of_query: 1 },
      query_params: {
        start: "2026-03-01T00:00:00.000Z",
        end: "2026-04-01T00:00:00.000Z",
      },
    });
  });

  it("writes both candidate sets and skips subsequent empty windows", async () => {
    const first = createClient([1, 1]);
    await backfillActivityOverviewAvailability(first.client, { ...RANGE, execute: true });
    expect(first.command).toHaveBeenCalledTimes(2);

    const second = createClient([]);
    await expect(
      backfillActivityOverviewAvailability(second.client, { ...RANGE, execute: true }),
    ).resolves.toEqual({
      distanceRows: 0,
      elevationRows: 0,
    });
    expect(second.command).not.toHaveBeenCalled();
  });
});
