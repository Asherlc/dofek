import { beforeEach, describe, expect, it, vi } from "vitest";

const connect = vi.fn();
const end = vi.fn();

vi.mock("pg", () => ({
  Pool: class {
    connect = connect;
    end = end;
  },
}));

import { createTaggedQueryClient } from "./tagged-query-client.ts";

describe("tagged query client transactions", () => {
  beforeEach(() => {
    connect.mockReset();
    end.mockReset();
  });

  it("preserves the operation error when rollback fails", async () => {
    const operationError = new Error("operation failed");
    const rollbackError = new Error("rollback failed");
    const query = vi.fn().mockResolvedValueOnce({ rows: [] }).mockRejectedValueOnce(rollbackError);
    const release = vi.fn();
    connect.mockResolvedValue({ query, release });
    const sql = createTaggedQueryClient("postgres://test");

    await expect(
      sql.transaction(async () => {
        throw operationError;
      }),
    ).rejects.toSatisfy(
      (error: unknown) =>
        error instanceof AggregateError &&
        error.errors.includes(operationError) &&
        error.errors.includes(rollbackError),
    );
    expect(release).toHaveBeenCalledOnce();
  });
});
