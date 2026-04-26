import { describe, expect, it, vi } from "vitest";
import { BillingRepository } from "./billing-repository.ts";

describe("BillingRepository", () => {
  it("returns null when a user has no billing row", async () => {
    const execute = vi.fn(async () => []);
    const repo = new BillingRepository({ execute });

    await expect(repo.findByUserId("user-1")).resolves.toBeNull();
    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ queryChunks: expect.any(Array) }),
    );
  });

  it("upserts an existing-account paid grant", async () => {
    const execute = vi.fn(async () => []);
    const repo = new BillingRepository({ execute });

    await repo.upsertPaidGrant("user-1", "existing_account");

    expect(execute).toHaveBeenCalledWith(
      expect.objectContaining({ queryChunks: expect.any(Array) }),
    );
  });
});
