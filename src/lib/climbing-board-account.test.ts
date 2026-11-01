import { ProviderServiceUnavailableError } from "@dofek/provider-http/rate-limit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProviderSessionExpiredError } from "../providers/auth-errors.ts";
import { SyncRun } from "../providers/sync-run.ts";
import { SyncWindow } from "../providers/sync-window.ts";
import { createMockDatabase } from "../providers/test-helpers.ts";
import { ClimbingBoardAccount } from "./climbing-board-account.ts";

const mocks = vi.hoisted(() => ({ captureException: vi.fn() }));
vi.mock("./error-reporting.ts", () => ({ captureException: mocks.captureException }));
vi.mock("../db/tokens.ts", () => ({
  ensureProvider: vi.fn(),
  loadTokens: vi.fn(async () => ({ accessToken: "board-session" })),
  saveTokens: vi.fn(),
}));
vi.mock("../db/sync-log.ts", () => ({
  withSyncLog: vi.fn(async (_db, _provider, _type, operation) => (await operation()).result),
}));
afterEach(() => vi.clearAllMocks());

function failSync(error: Error) {
  const account = new ClimbingBoardAccount("tension", "Tension Board", "https://example.com", {
    login: vi.fn(),
    fetchLogbook: vi.fn(async () => {
      throw error;
    }),
  });
  return account.sync(
    new SyncRun({
      db: createMockDatabase().db,
      userId: "board-owner",
      window: SyncWindow.full(new Date("2026-11-01T00:00:00Z")),
    }),
  );
}

describe("board sync error reporting", () => {
  it("returns expired authorization for user reconnection without a per-attempt exception", async () => {
    const error = new ProviderSessionExpiredError("Tension Board");
    expect(await failSync(error)).toMatchObject({ errors: [{ cause: error }] });
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it("preserves transport errors for worker recovery without a per-attempt exception", async () => {
    const error = new ProviderServiceUnavailableError({
      message: "Tension Board is temporarily unavailable",
      providerId: "tension",
      statusCode: 503,
      responseBody: "maintenance",
    });
    await expect(failSync(error)).rejects.toBe(error);
    expect(mocks.captureException).not.toHaveBeenCalled();
  });

  it("reports an unexpected malformed response and keeps its cause in sync status", async () => {
    const error = new SyntaxError("Invalid board response");
    expect(await failSync(error)).toMatchObject({ errors: [{ cause: error }] });
    expect(mocks.captureException).toHaveBeenCalledExactlyOnceWith(error, {
      tags: { provider: "tension", phase: "climbing_activity" },
    });
  });
});
