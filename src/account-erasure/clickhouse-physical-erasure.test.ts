import { describe, expect, it, vi } from "vitest";
import type { ClickHousePhysicalErasureClient } from "./clickhouse-physical-erasure.ts";
import {
  applyClickHousePhysicalErasureMutation,
  classifyClickHouseManagedTableEngine,
  prepareClickHousePhysicalErasure,
  waitForClickHousePhysicalErasure,
} from "./clickhouse-physical-erasure.ts";

describe("classifyClickHouseManagedTableEngine", () => {
  it.each([
    ["MaterializedView", "non-storage"],
    ["Null", "non-storage"],
    ["View", "non-storage"],
    ["MergeTree", "merge-tree"],
    ["ReplacingMergeTree", "merge-tree"],
    ["Memory", "unsupported-storage"],
  ] as const)("classifies %s", (engine, expected) => {
    expect(classifyClickHouseManagedTableEngine(engine)).toBe(expected);
  });
});

describe("prepareClickHousePhysicalErasure", () => {
  it("tracks matching part lineage instead of every inactive table part", async () => {
    const query = vi.fn<ClickHousePhysicalErasureClient["query"]>(async (options) => {
      if (options.query.includes("FROM system.detached_parts")) {
        return { json: async () => [] };
      }

      if (options.query.includes("SELECT DISTINCT _part")) {
        return { json: async () => [{ part_name: "target-part" }] };
      }

      if (options.query.includes("FROM system.parts")) {
        return { json: async () => [{ part_name: "unrelated-inactive-part" }] };
      }

      if (options.query.includes("FROM system.part_log")) {
        return { json: async () => [] };
      }

      throw new Error(`Unexpected ClickHouse query: ${options.query}`);
    });

    const client: ClickHousePhysicalErasureClient = {
      command: vi.fn(async () => undefined),
      query,
    };

    const target = await prepareClickHousePhysicalErasure(
      client,
      { database: "analytics", name: "provider_change_state" },
      {
        sql: "user_id = {user_id:UUID}",
        queryParameters: { user_id: "user-id" },
      },
    );

    expect(target.partNames).toEqual(new Set(["target-part"]));
  });

  it("adds completed mutation lineage to the physical erasure target", async () => {
    const query = vi.fn<ClickHousePhysicalErasureClient["query"]>(async (options) => {
      if (options.query.includes("FROM system.detached_parts")) {
        return { json: async () => [] };
      }

      if (options.query.includes("FROM system.mutations")) {
        return { json: async () => [{ mutation_id: "mutation-1" }] };
      }

      if (options.query.includes("hasAny(mutation_ids")) {
        return {
          json: async () => [{ merged_from: ["target-part"], part_name: "mutated-part" }],
        };
      }

      if (options.query.includes("FROM system.part_log")) {
        return {
          json: async () => [{ merged_from: ["source-part"], part_name: "mutated-part" }],
        };
      }

      if (options.query.includes("SELECT count()")) {
        return { json: async () => [{ count: "0" }] };
      }

      throw new Error(`Unexpected ClickHouse query: ${options.query}`);
    });

    const client: ClickHousePhysicalErasureClient = {
      command: vi.fn(async () => undefined),
      query,
    };
    const target = {
      partNames: new Set(["target-part"]),
      predicate: {
        sql: "user_id = {user_id:UUID}",
        queryParameters: { user_id: "user-id" },
      },
      table: { database: "analytics", name: "provider_change_state" },
    };

    await applyClickHousePhysicalErasureMutation(client, target);

    const mutationCommand = vi.mocked(client.command).mock.calls[0]?.[0];
    expect(mutationCommand?.query).toMatch(/AND '[0-9a-f-]{36}'\s*=\s*'[0-9a-f-]{36}'/);
    expect(mutationCommand?.query_params).not.toHaveProperty("account_erasure_mutation_marker");
    expect(target.partNames).toEqual(new Set(["target-part", "source-part"]));
  });

  it("follows multiple generations of matching part lineage", async () => {
    let lineageQuery = 0;
    const query = vi.fn<ClickHousePhysicalErasureClient["query"]>(async (options) => {
      if (options.query.includes("FROM system.detached_parts")) {
        return { json: async () => [] };
      }
      if (options.query.includes("SELECT DISTINCT _part")) {
        return { json: async () => [{ part_name: "new-part" }] };
      }
      if (options.query.includes("FROM system.part_log")) {
        lineageQuery += 1;
        return {
          json: async () =>
            lineageQuery === 1
              ? [{ merged_from: ["old-part"], part_name: "new-part" }]
              : [{ merged_from: ["oldest-part"], part_name: "old-part" }],
        };
      }
      throw new Error(`Unexpected ClickHouse query: ${options.query}`);
    });

    const target = await prepareClickHousePhysicalErasure(
      { command: vi.fn(async () => undefined), query },
      { database: "analytics", name: "provider_change_state" },
      { queryParameters: {}, sql: "1 = 1" },
    );

    expect(target.partNames).toEqual(new Set(["new-part", "old-part", "oldest-part"]));
  });

  it("batches a large part-lineage lookup without dropping the final batch", async () => {
    const partNames = Array.from({ length: 501 }, (_, index) => `part-${index}`);
    const lineageBatchSizes: number[] = [];
    const query = vi.fn<ClickHousePhysicalErasureClient["query"]>(async (options) => {
      if (options.query.includes("FROM system.detached_parts")) {
        return { json: async () => [] };
      }
      if (options.query.includes("SELECT DISTINCT _part")) {
        return { json: async () => partNames.map((part_name) => ({ part_name })) };
      }
      if (options.query.includes("FROM system.part_log")) {
        const partNamesParameter = options.query_params?.part_names;
        if (!Array.isArray(partNamesParameter)) {
          throw new Error("missing part-name batch");
        }
        lineageBatchSizes.push(partNamesParameter.length);
        return { json: async () => [] };
      }
      throw new Error(`Unexpected ClickHouse query: ${options.query}`);
    });

    const target = await prepareClickHousePhysicalErasure(
      { command: vi.fn(async () => undefined), query },
      { database: "analytics", name: "provider_change_state" },
      { queryParameters: {}, sql: "1 = 1" },
    );

    expect(target.partNames.size).toBe(501);
    expect(lineageBatchSizes).toEqual([500, 1]);
  });

  it("fails closed when detached parts are present", async () => {
    const query = vi.fn<ClickHousePhysicalErasureClient["query"]>(async (options) => {
      if (options.query.includes("FROM system.detached_parts")) {
        return { json: async () => [{ part_name: "detached-part" }] };
      }
      throw new Error(`Unexpected ClickHouse query: ${options.query}`);
    });

    await expect(
      prepareClickHousePhysicalErasure(
        { command: vi.fn(async () => undefined), query },
        { database: "analytics", name: "provider_change_state" },
        { queryParameters: {}, sql: "1 = 1" },
      ),
    ).rejects.toThrow("detached parts remain");
  });

  it("accepts a mutation predicate with separate opaque parameters", async () => {
    const query = vi.fn<ClickHousePhysicalErasureClient["query"]>(async (options) => {
      if (options.query.includes("FROM system.detached_parts")) {
        return { json: async () => [] };
      }
      if (options.query.includes("SELECT count()")) {
        return { json: async () => [{ count: "0" }] };
      }
      if (options.query.includes("FROM system.mutations")) {
        return { json: async () => [] };
      }
      throw new Error(`Unexpected ClickHouse query: ${options.query}`);
    });
    const command = vi.fn(async () => undefined);

    await applyClickHousePhysicalErasureMutation(
      { command, query },
      {
        partNames: new Set(),
        predicate: {
          mutationQueryParameters: { user_hash: "opaque" },
          mutationSql: "user_hash = {user_hash:String}",
          queryParameters: { user_id: "raw" },
          sql: "user_id = {user_id:UUID}",
        },
        table: { database: "analytics", name: "provider_change_state" },
      },
    );

    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        query_params: { user_hash: "opaque" },
      }),
    );
  });

  it("flushes system logs and records all completed mutation lineage", async () => {
    const query = vi.fn<ClickHousePhysicalErasureClient["query"]>(async (options) => {
      if (options.query.includes("FROM system.detached_parts")) {
        return { json: async () => [] };
      }
      if (options.query.includes("FROM system.mutations")) {
        return { json: async () => [{ mutation_id: "mutation-1" }, { mutation_id: "mutation-2" }] };
      }
      if (options.query.includes("hasAny(mutation_ids")) {
        return {
          json: async () => [
            { merged_from: ["mutated-source-1"], part_name: "mutated-part-1" },
            { merged_from: ["mutated-source-2"], part_name: "mutated-part-2" },
          ],
        };
      }
      if (options.query.includes("FROM system.part_log")) {
        return { json: async () => [] };
      }
      if (options.query.includes("SELECT count()")) {
        return { json: async () => [{ count: "0" }] };
      }
      throw new Error(`Unexpected ClickHouse query: ${options.query}`);
    });
    const command = vi.fn(async () => undefined);
    const target = {
      partNames: new Set<string>(),
      predicate: { queryParameters: {}, sql: "1 = 1" },
      table: { database: "analytics", name: "provider_change_state" },
    };

    await applyClickHousePhysicalErasureMutation({ command, query }, target);

    expect(command).toHaveBeenCalledWith(expect.objectContaining({ query: "SYSTEM FLUSH LOGS" }));
    expect(target.partNames).toEqual(new Set(["mutated-source-1", "mutated-source-2"]));
  });

  it("fails when rows remain after a synchronous mutation", async () => {
    const query = vi.fn<ClickHousePhysicalErasureClient["query"]>(async (options) => {
      if (options.query.includes("FROM system.detached_parts")) {
        return { json: async () => [] };
      }
      if (options.query.includes("SELECT count()")) {
        return { json: async () => [{ count: "2" }] };
      }
      throw new Error(`Unexpected ClickHouse query: ${options.query}`);
    });

    await expect(
      applyClickHousePhysicalErasureMutation(
        { command: vi.fn(async () => undefined), query },
        {
          partNames: new Set(),
          predicate: { queryParameters: {}, sql: "1 = 1" },
          table: { database: "analytics", name: "provider_change_state" },
        },
      ),
    ).rejects.toThrow("left 2 row(s)");
  });

  it("waits for retained parts to disappear and accepts an empty target", async () => {
    const query = vi.fn<ClickHousePhysicalErasureClient["query"]>(async (options) => {
      if (options.query.includes("FROM system.detached_parts")) {
        return { json: async () => [] };
      }
      if (options.query.includes("FROM system.parts")) {
        return { json: async () => [{ count: "0" }] };
      }
      throw new Error(`Unexpected ClickHouse query: ${options.query}`);
    });
    const client = { command: vi.fn(async () => undefined), query };
    const table = { database: "analytics", name: "provider_change_state" };

    await expect(
      waitForClickHousePhysicalErasure(
        client,
        [
          {
            partNames: new Set(["part-1"]),
            predicate: { queryParameters: {}, sql: "1 = 1" },
            table,
          },
        ],
        { pollIntervalMilliseconds: 0, waitTimeoutMilliseconds: 100 },
      ),
    ).resolves.toBeUndefined();
    await expect(
      waitForClickHousePhysicalErasure(
        client,
        [{ partNames: new Set(), predicate: { queryParameters: {}, sql: "1 = 1" }, table }],
        { pollIntervalMilliseconds: 0, waitTimeoutMilliseconds: 0 },
      ),
    ).resolves.toBeUndefined();
  });

  it("deduplicates references and waits through a retained-part observation", async () => {
    let retainedQueries = 0;
    const query = vi.fn<ClickHousePhysicalErasureClient["query"]>(async (options) => {
      if (options.query.includes("FROM system.detached_parts")) {
        return { json: async () => [] };
      }
      if (options.query.includes("FROM system.parts")) {
        retainedQueries += 1;
        return { json: async () => [{ count: retainedQueries === 1 ? "1" : "0" }] };
      }
      throw new Error(`Unexpected ClickHouse query: ${options.query}`);
    });
    const table = { database: "analytics", name: "provider_change_state" };
    const target = {
      partNames: new Set(["part-1"]),
      predicate: { queryParameters: {}, sql: "1 = 1" },
      table,
    };

    await expect(
      waitForClickHousePhysicalErasure(
        { command: vi.fn(async () => undefined), query },
        [target, { ...target, partNames: new Set(["part-1", "part-2"]) }],
        { pollIntervalMilliseconds: 0, waitTimeoutMilliseconds: 100 },
      ),
    ).resolves.toBeUndefined();
    expect(retainedQueries).toBe(2);
  });

  it("fails if a detached part appears while waiting", async () => {
    let detachedChecks = 0;
    const query = vi.fn<ClickHousePhysicalErasureClient["query"]>(async (options) => {
      if (options.query.includes("FROM system.detached_parts")) {
        detachedChecks += 1;
        return { json: async () => (detachedChecks > 1 ? [{ part_name: "detached" }] : []) };
      }
      if (options.query.includes("FROM system.parts")) {
        return { json: async () => [{ count: "1" }] };
      }
      throw new Error(`Unexpected ClickHouse query: ${options.query}`);
    });

    await expect(
      waitForClickHousePhysicalErasure(
        { command: vi.fn(async () => undefined), query },
        [
          {
            partNames: new Set(["part-1"]),
            predicate: { queryParameters: {}, sql: "1 = 1" },
            table: { database: "analytics", name: "provider_change_state" },
          },
        ],
        { pollIntervalMilliseconds: 0, waitTimeoutMilliseconds: 100 },
      ),
    ).rejects.toThrow("detached parts remain");
  });

  it("times out while a physical part remains retained", async () => {
    const query = vi.fn<ClickHousePhysicalErasureClient["query"]>(async (options) => {
      if (options.query.includes("FROM system.detached_parts")) {
        return { json: async () => [] };
      }
      if (options.query.includes("FROM system.parts")) {
        return { json: async () => [{ count: "1" }] };
      }
      throw new Error(`Unexpected ClickHouse query: ${options.query}`);
    });

    await expect(
      waitForClickHousePhysicalErasure(
        { command: vi.fn(async () => undefined), query },
        [
          {
            partNames: new Set(["part-1"]),
            predicate: { queryParameters: {}, sql: "1 = 1" },
            table: { database: "analytics", name: "provider_change_state" },
          },
        ],
        { pollIntervalMilliseconds: 0, waitTimeoutMilliseconds: 0 },
      ),
    ).rejects.toThrow("timed out waiting for 1 physical part");
  });
});
