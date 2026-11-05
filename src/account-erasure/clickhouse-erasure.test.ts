import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ClickHouseCommandClient } from "../db/clickhouse.ts";
import { fenceClickHouseAccount } from "./clickhouse-erasure.ts";

const userId = "10000000-0000-4000-8000-000000001994";
const operationId = "20000000-0000-4000-8000-000000001994";
describe("fenceClickHouseAccount", () => {
  it("rejects an oversized caller page before admitting any fence", async () => {
    const command = vi.fn<ClickHouseCommandClient["command"]>(async () => undefined);
    const insert = vi.fn<NonNullable<ClickHouseCommandClient["insert"]>>(async () => undefined);
    await expect(
      fenceClickHouseAccount(
        { command, insert, query: async () => ({ json: async () => [] }) },
        userId,
        Array.from({ length: 501 }, () => operationId),
      ),
    ).rejects.toMatchObject({ name: "AccountErasureIdentifierBudgetError" });
    expect(command).not.toHaveBeenCalled();
  });
  it("fences exact user and operation hashes, deduplicating its bounded input", async () => {
    const command = vi.fn<ClickHouseCommandClient["command"]>(async () => undefined);
    const insert = vi.fn<NonNullable<ClickHouseCommandClient["insert"]>>(async () => undefined);
    await fenceClickHouseAccount(
      { command, insert, query: async () => ({ json: async () => [] }) },
      userId,
      [operationId, operationId],
    );
    expect(command).toHaveBeenCalledWith(
      expect.objectContaining({
        query_params: { user_hash: createHash("sha256").update(userId).digest("hex") },
      }),
    );
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        values: [{ operation_hash: createHash("sha256").update(operationId).digest("hex") }],
      }),
    );
  });
  it("requires operation fence insertion support", async () => {
    await expect(
      fenceClickHouseAccount(
        { command: async () => undefined, query: async () => ({ json: async () => [] }) },
        userId,
        [operationId],
      ),
    ).rejects.toThrow("requires insert support");
  });
});
