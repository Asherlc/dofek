import type { Database } from "dofek/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { findAccount } from "./account.ts";

const execute = vi.fn();

function mockDb(): Pick<Database, "execute"> {
  return { execute };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("findAccount", () => {
  it("returns the account for an existing Dofek user", async () => {
    execute.mockResolvedValue([{ id: "123e4567-e89b-12d3-a456-426614174000" }]);

    await expect(
      findAccount(mockDb(), {}, "123e4567-e89b-12d3-a456-426614174000"),
    ).resolves.toMatchObject({ accountId: "123e4567-e89b-12d3-a456-426614174000" });
  });

  it("returns undefined when the account no longer exists", async () => {
    execute.mockResolvedValue([]);

    await expect(
      findAccount(mockDb(), {}, "123e4567-e89b-12d3-a456-426614174000"),
    ).resolves.toBeUndefined();
  });
});
