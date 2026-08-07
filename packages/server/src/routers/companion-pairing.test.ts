import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

const {
  mockGetByShortCode,
  mockConsumeClaimAttempt,
  mockClaimChallenge,
  mockSetClaimedChallengeToken,
  mockReleaseClaimedChallengeTokenIssuance,
  mockDeleteClaimedChallenge,
  mockRegenerateCompanionToken,
  mockCaptureException,
  mockWithUserWriteFence,
} = vi.hoisted(() => ({
  mockGetByShortCode: vi.fn(),
  mockConsumeClaimAttempt: vi.fn(),
  mockClaimChallenge: vi.fn(),
  mockSetClaimedChallengeToken: vi.fn(),
  mockReleaseClaimedChallengeTokenIssuance: vi.fn(),
  mockDeleteClaimedChallenge: vi.fn(),
  mockRegenerateCompanionToken: vi.fn(),
  mockCaptureException: vi.fn(),
  mockWithUserWriteFence: vi.fn(),
}));

vi.mock("dofek/db/account-erasure", () => ({
  withAccountErasureUserWriteFence: (...args: unknown[]) => mockWithUserWriteFence(...args),
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
    setClaimedChallengeToken: (...args: unknown[]) => mockSetClaimedChallengeToken(...args),
    releaseClaimedChallengeTokenIssuance: (...args: unknown[]) =>
      mockReleaseClaimedChallengeTokenIssuance(...args),
    deleteClaimedChallenge: (...args: unknown[]) => mockDeleteClaimedChallenge(...args),
  }),
  parsePairingCodeInput: (code: string) => {
    const normalizedCode = code.replace(/[\s-]/g, "").trim().toUpperCase();
    return /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/.test(normalizedCode) ? normalizedCode : null;
  },
}));

vi.mock("../companion/token-repository.ts", () => ({
  regenerateCompanionTokenInTransaction: (...args: unknown[]) =>
    mockRegenerateCompanionToken(...args),
}));

vi.mock("dofek/lib/error-reporting", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

const { companionPairingRouter } = await import("./companion-pairing.ts");

const createCaller = createTestCallerFactory(companionPairingRouter);
const transaction = { execute: vi.fn() };

describe("companionPairingRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConsumeClaimAttempt.mockResolvedValue(true);
    mockDeleteClaimedChallenge.mockResolvedValue(true);
    mockWithUserWriteFence.mockImplementation(
      async (
        _database: unknown,
        _userId: string,
        operation: (database: typeof transaction) => Promise<unknown>,
      ) => operation(transaction),
    );
  });

  it("claims an active pairing code", async () => {
    mockGetByShortCode.mockResolvedValue({
      id: "pairing-1",
      shortCode: "ABC234",
      connectionType: "zepp-workout",
      createdAt: "2026-07-12T00:00:00.000Z",
      expiresAt: "2026-07-12T00:10:00.000Z",
    });
    mockClaimChallenge.mockResolvedValue({
      id: "pairing-1",
      shortCode: "ABC234",
      connectionType: "zepp-workout",
      createdAt: "2026-07-12T00:00:00.000Z",
      expiresAt: "2026-07-12T00:10:00.000Z",
      claimedAt: "2026-07-12T00:01:00.000Z",
      userId: "user-1",
    });
    mockRegenerateCompanionToken.mockResolvedValue({
      id: "token-1",
      connectionType: "zepp-workout",
      token: "dofek_companion_test",
      createdAt: "2026-07-12T00:00:00.000Z",
      revokedAt: null,
    });
    mockSetClaimedChallengeToken.mockResolvedValue({
      id: "pairing-1",
      shortCode: "ABC234",
      connectionType: "zepp-workout",
      createdAt: "2026-07-12T00:00:00.000Z",
      expiresAt: "2026-07-12T00:10:00.000Z",
      claimedAt: "2026-07-12T00:01:00.000Z",
      userId: "user-1",
      companionToken: "dofek_companion_test",
    });

    const caller = createCaller({ db: {}, userId: "user-1", timezone: "UTC" });

    await expect(caller.claim({ code: "ABC234" })).resolves.toEqual({
      state: "claimed",
      connectionType: "zepp-workout",
      expiresAt: "2026-07-12T00:10:00.000Z",
    });
    expect(mockConsumeClaimAttempt).toHaveBeenCalledWith("user-1");
    expect(mockRegenerateCompanionToken).toHaveBeenCalledWith(
      transaction,
      "user-1",
      "zepp-workout",
    );
    expect(mockRegenerateCompanionToken).toHaveBeenCalledTimes(1);
    expect(mockClaimChallenge).toHaveBeenCalledWith({
      shortCode: "ABC234",
      userId: "user-1",
    });
    expect(mockSetClaimedChallengeToken).toHaveBeenCalledWith({
      shortCode: "ABC234",
      userId: "user-1",
      companionToken: "dofek_companion_test",
    });
  });

  it("rotates a token only for the atomic claim winner", async () => {
    mockGetByShortCode.mockResolvedValue({
      id: "pairing-1",
      shortCode: "ABC234",
      createdAt: "2026-07-12T00:00:00.000Z",
      expiresAt: "2026-07-12T00:10:00.000Z",
    });
    let claimReserved = false;
    mockClaimChallenge.mockImplementation(async ({ userId }: { userId: string }) => {
      if (claimReserved) return null;
      claimReserved = true;
      return {
        id: "pairing-1",
        shortCode: "ABC234",
        createdAt: "2026-07-12T00:00:00.000Z",
        expiresAt: "2026-07-12T00:10:00.000Z",
        claimedAt: "2026-07-12T00:01:00.000Z",
        userId,
      };
    });
    mockRegenerateCompanionToken.mockResolvedValue({
      id: "token-1",
      token: "dofek_companion_test",
      createdAt: "2026-07-12T00:00:00.000Z",
      revokedAt: null,
    });
    mockSetClaimedChallengeToken.mockResolvedValue({
      id: "pairing-1",
      shortCode: "ABC234",
      createdAt: "2026-07-12T00:00:00.000Z",
      expiresAt: "2026-07-12T00:10:00.000Z",
      claimedAt: "2026-07-12T00:01:00.000Z",
      userId: "user-1",
      companionToken: "dofek_companion_test",
    });
    const winner = createCaller({ db: {}, userId: "user-1", timezone: "UTC" });
    const duplicate = createCaller({ db: {}, userId: "user-1", timezone: "UTC" });
    const loser = createCaller({ db: {}, userId: "user-2", timezone: "UTC" });

    const results = await Promise.allSettled([
      winner.claim({ code: "ABC234" }),
      duplicate.claim({ code: "ABC234" }),
      loser.claim({ code: "ABC234" }),
    ]);

    expect(results[0]).toMatchObject({ status: "fulfilled" });
    expect(results[1]).toMatchObject({ status: "rejected" });
    expect(results[2]).toMatchObject({ status: "rejected" });
    expect(mockRegenerateCompanionToken).toHaveBeenCalledOnce();
    expect(mockRegenerateCompanionToken).toHaveBeenCalledWith(transaction, "user-1", "zepp-main");
    expect(mockSetClaimedChallengeToken).toHaveBeenCalledOnce();
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
    mockClaimChallenge.mockResolvedValue({
      id: "pairing-1",
      shortCode: "ABC234",
      createdAt: "2026-07-12T00:00:00.000Z",
      expiresAt: "2026-07-12T00:10:00.000Z",
      claimedAt: "2026-07-12T00:01:00.000Z",
      userId: "user-1",
    });
    const caller = createCaller({ db: {}, userId: "user-1", timezone: "UTC" });

    await expect(caller.claim({ code: "ABC234" })).rejects.toThrow(
      "Pairing code has already been used.",
    );
  });

  it("returns the completed claim without rotating its token again", async () => {
    mockGetByShortCode.mockResolvedValue({
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
      connectionType: "zepp-main",
      expiresAt: "2026-07-12T00:10:00.000Z",
    });
    expect(mockClaimChallenge).not.toHaveBeenCalled();
    expect(mockRegenerateCompanionToken).not.toHaveBeenCalled();
  });

  it("releases issuance when attaching the rotated token fails", async () => {
    mockGetByShortCode.mockResolvedValue({
      id: "pairing-1",
      shortCode: "ABC234",
      createdAt: "2026-07-12T00:00:00.000Z",
      expiresAt: "2026-07-12T00:10:00.000Z",
    });
    mockClaimChallenge.mockResolvedValue({
      id: "pairing-1",
      shortCode: "ABC234",
      createdAt: "2026-07-12T00:00:00.000Z",
      expiresAt: "2026-07-12T00:10:00.000Z",
      claimedAt: "2026-07-12T00:01:00.000Z",
      userId: "user-1",
      tokenIssuing: true,
    });
    mockRegenerateCompanionToken.mockResolvedValue({
      id: "token-1",
      token: "dofek_companion_test",
      createdAt: "2026-07-12T00:00:00.000Z",
      revokedAt: null,
    });
    mockSetClaimedChallengeToken.mockResolvedValue(null);
    const caller = createCaller({ db: {}, userId: "user-1", timezone: "UTC" });

    await expect(caller.claim({ code: "ABC234" })).rejects.toThrow(
      "Pairing code has already been used.",
    );
    expect(mockReleaseClaimedChallengeTokenIssuance).toHaveBeenCalledWith({
      shortCode: "ABC234",
      userId: "user-1",
    });
  });

  it("preserves the pairing failure when issuance cleanup fails", async () => {
    mockGetByShortCode.mockResolvedValue({
      id: "pairing-1",
      shortCode: "ABC234",
      createdAt: "2026-07-12T00:00:00.000Z",
      expiresAt: "2026-07-12T00:10:00.000Z",
    });
    mockClaimChallenge.mockResolvedValue({
      id: "pairing-1",
      shortCode: "ABC234",
      createdAt: "2026-07-12T00:00:00.000Z",
      expiresAt: "2026-07-12T00:10:00.000Z",
      claimedAt: "2026-07-12T00:01:00.000Z",
      userId: "user-1",
      tokenIssuing: true,
    });
    mockRegenerateCompanionToken.mockResolvedValue({
      id: "token-1",
      token: "dofek_companion_test",
      createdAt: "2026-07-12T00:00:00.000Z",
      revokedAt: null,
    });
    mockSetClaimedChallengeToken.mockResolvedValue(null);
    const cleanupError = new Error("Redis unavailable");
    mockReleaseClaimedChallengeTokenIssuance.mockRejectedValueOnce(cleanupError);
    const caller = createCaller({ db: {}, userId: "user-1", timezone: "UTC" });

    await expect(caller.claim({ code: "ABC234" })).rejects.toThrow(
      "Pairing code has already been used.",
    );
    expect(mockCaptureException).toHaveBeenCalledWith(cleanupError);
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

  it("rejects without claiming when token regeneration fails to return a token", async () => {
    mockGetByShortCode.mockResolvedValue({
      id: "pairing-1",
      shortCode: "ABC234",
      createdAt: "2026-07-12T00:00:00.000Z",
      expiresAt: "2026-07-12T00:10:00.000Z",
    });
    mockRegenerateCompanionToken.mockResolvedValue({
      id: "token-1",
      token: null,
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
    });
    const caller = createCaller({ db: {}, userId: "user-1", timezone: "UTC" });

    await expect(caller.claim({ code: "ABC234" })).rejects.toThrow(
      "Failed to create Dofek connection.",
    );
    expect(mockClaimChallenge).toHaveBeenCalledWith({ shortCode: "ABC234", userId: "user-1" });
    expect(mockSetClaimedChallengeToken).not.toHaveBeenCalled();
  });

  it("retries an interrupted winning claim without allowing another user to rotate a token", async () => {
    mockGetByShortCode.mockResolvedValue({
      id: "pairing-1",
      shortCode: "ABC234",
      createdAt: "2026-07-12T00:00:00.000Z",
      expiresAt: "2026-07-12T00:10:00.000Z",
      claimedAt: "2026-07-12T00:01:00.000Z",
      userId: "user-1",
    });
    mockClaimChallenge.mockResolvedValue({
      id: "pairing-1",
      shortCode: "ABC234",
      createdAt: "2026-07-12T00:00:00.000Z",
      expiresAt: "2026-07-12T00:10:00.000Z",
      claimedAt: "2026-07-12T00:01:00.000Z",
      userId: "user-1",
    });
    mockRegenerateCompanionToken
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce({
        id: "token-1",
        token: "dofek_companion_test",
        createdAt: "2026-07-12T00:00:00.000Z",
        revokedAt: null,
      });
    mockSetClaimedChallengeToken.mockResolvedValue({
      id: "pairing-1",
      shortCode: "ABC234",
      createdAt: "2026-07-12T00:00:00.000Z",
      expiresAt: "2026-07-12T00:10:00.000Z",
      claimedAt: "2026-07-12T00:01:00.000Z",
      userId: "user-1",
      companionToken: "dofek_companion_test",
    });
    mockReleaseClaimedChallengeTokenIssuance.mockResolvedValue({
      id: "pairing-1",
      shortCode: "ABC234",
      createdAt: "2026-07-12T00:00:00.000Z",
      expiresAt: "2026-07-12T00:10:00.000Z",
      claimedAt: "2026-07-12T00:01:00.000Z",
      userId: "user-1",
    });
    const winner = createCaller({ db: {}, userId: "user-1", timezone: "UTC" });
    const loser = createCaller({ db: {}, userId: "user-2", timezone: "UTC" });

    await expect(winner.claim({ code: "ABC234" })).rejects.toThrow("database unavailable");
    await expect(loser.claim({ code: "ABC234" })).rejects.toThrow(
      "Pairing code has already been used.",
    );
    await expect(winner.claim({ code: "ABC234" })).resolves.toMatchObject({ state: "claimed" });

    expect(mockRegenerateCompanionToken).toHaveBeenCalledTimes(2);
    expect(mockRegenerateCompanionToken).toHaveBeenLastCalledWith(
      transaction,
      "user-1",
      "zepp-main",
    );
    expect(mockSetClaimedChallengeToken).toHaveBeenCalledOnce();
  });

  it("rejects when the code is claimed by another request before token commit", async () => {
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
    mockClaimChallenge.mockResolvedValue(null);
    const caller = createCaller({ db: {}, userId: "user-1", timezone: "UTC" });

    await expect(caller.claim({ code: "ABC234" })).rejects.toThrow(
      "Pairing code has already been used.",
    );
    expect(mockConsumeClaimAttempt).toHaveBeenCalledWith("user-1");
    expect(mockClaimChallenge).toHaveBeenCalledWith({
      shortCode: "ABC234",
      userId: "user-1",
    });
  });

  it("removes the Redis claim when the fenced token transaction fails to commit", async () => {
    mockGetByShortCode.mockResolvedValue({
      id: "pairing-1",
      shortCode: "ABC234",
      createdAt: "2026-07-12T00:00:00.000Z",
      expiresAt: "2026-07-12T00:10:00.000Z",
    });
    mockClaimChallenge.mockResolvedValue({
      id: "pairing-1",
      shortCode: "ABC234",
      createdAt: "2026-07-12T00:00:00.000Z",
      expiresAt: "2026-07-12T00:10:00.000Z",
      claimedAt: "2026-07-12T00:01:00.000Z",
      userId: "user-1",
      tokenIssuing: true,
    });
    mockRegenerateCompanionToken.mockResolvedValue({
      id: "token-1",
      token: "dofek_companion_test",
      createdAt: "2026-07-12T00:00:00.000Z",
      revokedAt: null,
    });
    mockSetClaimedChallengeToken.mockResolvedValue({
      id: "pairing-1",
      shortCode: "ABC234",
      createdAt: "2026-07-12T00:00:00.000Z",
      expiresAt: "2026-07-12T00:10:00.000Z",
      claimedAt: "2026-07-12T00:01:00.000Z",
      userId: "user-1",
      companionToken: "dofek_companion_test",
    });
    mockWithUserWriteFence.mockImplementationOnce(
      async (
        _database: unknown,
        _userId: string,
        operation: (database: typeof transaction) => Promise<unknown>,
      ) => {
        await operation(transaction);
        throw new Error("commit failed");
      },
    );
    const caller = createCaller({ db: {}, userId: "user-1", timezone: "UTC" });

    await expect(caller.claim({ code: "ABC234" })).rejects.toThrow("commit failed");

    expect(mockDeleteClaimedChallenge).toHaveBeenCalledWith({
      shortCode: "ABC234",
      userId: "user-1",
      companionToken: "dofek_companion_test",
    });
  });

  it("does not mutate Redis when account erasure rejects the claim", async () => {
    mockWithUserWriteFence.mockRejectedValueOnce(new Error("Account erasure is active"));
    const caller = createCaller({ db: {}, userId: "user-1", timezone: "UTC" });

    await expect(caller.claim({ code: "ABC234" })).rejects.toThrow("Account erasure is active");

    expect(mockConsumeClaimAttempt).not.toHaveBeenCalled();
    expect(mockClaimChallenge).not.toHaveBeenCalled();
    expect(mockRegenerateCompanionToken).not.toHaveBeenCalled();
  });
});
