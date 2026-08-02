import { describe, expect, it, vi } from "vitest";
import type { ClickHousePhysicalErasureClient } from "./clickhouse-physical-erasure.ts";
import {
  applyClickHousePhysicalErasureMutation,
  prepareClickHousePhysicalErasure,
} from "./clickhouse-physical-erasure.ts";

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
    expect(target.partNames).toEqual(new Set(["target-part", "mutated-part", "source-part"]));
  });
});
