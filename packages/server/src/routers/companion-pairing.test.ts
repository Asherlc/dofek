import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

const {
  mockGetByShortCode,
  mockConsumeClaimAttempt,
  mockClaimChallenge,
  mockRegenerateCompanionToken,
} = vi.hoisted(() => ({
  mockGetByShortCode: vi.fn(),
  mockConsumeClaimAttempt: vi.fn(),
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
    consumeClaimAttempt: (...args: unknown[]) => mockConsumeClaimAttempt(...args),
    claimChallenge: (...args: unknown[]) => mockClaimChallenge(...args),
  }),
  parsePairingCodeInput: (code: string) => {
    const normalizedCode = code.replace(/[\s-]/g, "").trim().toUpperCase();
    return /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(normalizedCode) ? normalizedCode : null;
  },
}));

vi.mock("../companion/token-repository.ts", () => ({
  regenerateCompanionToken: (...args: unknown[]) => mockRegenerateCompanionToken(...args),
}));

const { companionPairingRouter } = await import("./companion-pairing.ts");

const createCaller = createTestCallerFactory(companionPairingRouter);

describe("companionPairingRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConsumeClaimAttempt.mockResolvedValue(true);
  });

  it("claims an active pairing code", async () => {
    mockGetByShortCode.mockResolvedValue({
      id: "pairing-1",
      shortCode: "ABC234",
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
      shortCode: "ABC234",
      createdAt: "2026-07-12T00:00:00.000Z",
      expiresAt: "2026-07-12T00:10:00.000Z",
      claimedAt: "2026-07-12T00:01:00.000Z",
      userId: "user-1",
      companionToken: "dofek_companion_test",
    });

    const caller = createCaller({ db: {}, userId: "user-1", timezone: "UTC" });

    await expect(caller.claim({ code: "ABC234" })).resolves.toEqual({
      state: "claimed",
      expiresAt: "2026-07-12T00:10:00.000Z",
    });
    expect(mockRegenerateCompanionToken).toHaveBeenCalledWith({}, "user-1");
    expect(mockConsumeClaimAttempt).toHaveBeenCalledWith("user-1");
    expect(mockClaimChallenge).toHaveBeenCalledWith({
      shortCode: "ABC234",
      userId: "user-1",
      companionToken: "dofek_companion_test",
    });
  });

  it("rejects missing or expired codes", async () => {
    mockGetByShortCode.mockResolvedValue(null);
    const caller = createCaller({ db: {}, userId: "user-1", timezone: "UTC" });

    await expect(caller.claim({ code: "MSS234" })).rejects.toThrow(
      "Pairing code was not found or has expired.",
    );
  });

  it("rejects invalid code formats before probing the store", async () => {
    const caller = createCaller({ db: {}, userId: "user-1", timezone: "UTC" });

    await expect(caller.claim({ code: "I0O1AA" })).rejects.toThrow(
      "Enter a valid six-character Zepp pairing code.",
    );
    expect(mockGetByShortCode).not.toHaveBeenCalled();
  });

  it("rejects already claimed codes", async () => {
    mockGetByShortCode.mockResolvedValue({
      id: "pairing-1",
      shortCode: "ABC234",
      createdAt: "2026-07-12T00:00:00.000Z",
      expiresAt: "2026-07-12T00:10:00.000Z",
      claimedAt: "2026-07-12T00:01:00.000Z",
    });
    const caller = createCaller({ db: {}, userId: "user-1", timezone: "UTC" });

    await expect(caller.claim({ code: "ABC234" })).rejects.toThrow(
      "Pairing code has already been used.",
    );
  });

  it("rejects claims after the shared store limiter is exhausted", async () => {
    mockConsumeClaimAttempt.mockResolvedValue(false);
    const caller = createCaller({ db: {}, userId: "rate-limited-user", timezone: "UTC" });

    await expect(caller.claim({ code: "ABC234" })).rejects.toThrow(
      "Too many pairing attempts. Please wait a few minutes and try again.",
    );
    expect(mockConsumeClaimAttempt).toHaveBeenCalledWith("rate-limited-user");
    expect(mockGetByShortCode).not.toHaveBeenCalled();
  });
});
