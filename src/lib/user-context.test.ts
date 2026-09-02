import { describe, expect, it, vi } from "vitest";

const mockGetTokenUserId = vi.fn();

vi.mock("../db/token-user-context.ts", () => ({
  getTokenUserId: mockGetTokenUserId,
}));

describe("resolveScopedUserId", () => {
  it("returns the provided userId when given", async () => {
    const { resolveScopedUserId } = await import("./user-context.ts");

    const result = resolveScopedUserId("user-abc");

    expect(result).toBe("user-abc");
    expect(mockGetTokenUserId).not.toHaveBeenCalled();
  });

  it("falls back to token user ID when no userId is provided", async () => {
    const { resolveScopedUserId } = await import("./user-context.ts");
    mockGetTokenUserId.mockReturnValue("token-user-xyz");

    const result = resolveScopedUserId();

    expect(result).toBe("token-user-xyz");
    expect(mockGetTokenUserId).toHaveBeenCalledOnce();
  });

  it("throws when neither userId nor token user ID is available", async () => {
    const { resolveScopedUserId } = await import("./user-context.ts");
    mockGetTokenUserId.mockReturnValue(undefined);

    expect(() => resolveScopedUserId()).toThrow("A user ID is required for this operation");
  });
});
