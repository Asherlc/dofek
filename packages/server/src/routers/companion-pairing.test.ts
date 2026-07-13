import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

const { mockGetByShortCode, mockClaimChallenge, mockRegenerateCompanionToken } = vi.hoisted(() => ({
  mockGetByShortCode: vi.fn(),
  mockClaimChallenge: vi.fn(),
  mockRegenerateCompanionToken: vi.fn(),
}));

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC
    .context<{ db: unknown; userId: string | null; timezone: string }>()
    .create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
  };
});

vi.mock("../lib/companion-pairing-store.ts", () => ({
  getCompanionPairingStore: () => ({
    getByShortCode: (...args: unknown[]) => mockGetByShortCode(...args),
    claimChallenge: (...args: unknown[]) => mockClaimChallenge(...args),
  }),
}));

vi.mock("../companion/token-repository.ts", () => ({
  regenerateCompanionToken: (...args: unknown[]) => mockRegenerateCompanionToken(...args),
}));

const { companionPairingRouter } = await import("./companion-pairing.ts");

const createCaller = createTestCallerFactory(companionPairingRouter);

describe("companionPairingRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("claims an active pairing code", async () => {
    mockGetByShortCode.mockResolvedValue({
      id: "pairing-1",
      shortCode: "ABC123",
      createdAt: "2026-07-12T00:00:00.000Z",
      expiresAt: "2026-07-12T00:10:00.000Z",
    });
    mockRegenerateCompanionToken.mockResolvedValue({
      id: "token-1",
      token: "dofek_companion_test",
      createdAt: "2026-07-12T00:00:00.000Z",
      revokedAt: null,
    });
    mockClaimChallenge.mockResolvedValue({
      id: "pairing-1",
      shortCode: "ABC123",
      createdAt: "2026-07-12T00:00:00.000Z",
      expiresAt: "2026-07-12T00:10:00.000Z",
      claimedAt: "2026-07-12T00:01:00.000Z",
      userId: "user-1",
      companionToken: "dofek_companion_test",
    });

    const caller = createCaller({ db: {}, userId: "user-1", timezone: "UTC" });

    await expect(caller.claim({ code: "ABC123" })).resolves.toEqual({
      state: "claimed",
      expiresAt: "2026-07-12T00:10:00.000Z",
    });
    expect(mockRegenerateCompanionToken).toHaveBeenCalledWith({}, "user-1");
    expect(mockClaimChallenge).toHaveBeenCalledWith({
      shortCode: "ABC123",
      userId: "user-1",
      companionToken: "dofek_companion_test",
    });
  });

  it("rejects missing or expired codes", async () => {
    mockGetByShortCode.mockResolvedValue(null);
    const caller = createCaller({ db: {}, userId: "user-1", timezone: "UTC" });

    await expect(caller.claim({ code: "MISSING" })).rejects.toThrow(
      "Pairing code was not found or has expired.",
    );
  });

  it("rejects already claimed codes", async () => {
    mockGetByShortCode.mockResolvedValue({
      id: "pairing-1",
      shortCode: "ABC123",
      createdAt: "2026-07-12T00:00:00.000Z",
      expiresAt: "2026-07-12T00:10:00.000Z",
      claimedAt: "2026-07-12T00:01:00.000Z",
    });
    const caller = createCaller({ db: {}, userId: "user-1", timezone: "UTC" });

    await expect(caller.claim({ code: "ABC123" })).rejects.toThrow(
      "Pairing code has already been used.",
    );
  });
});
