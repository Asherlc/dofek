import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  captureException: vi.fn(),
  createTicket: vi.fn(),
  deleteTicket: vi.fn(),
  loggerError: vi.fn(),
  loggerInfo: vi.fn(),
  recordUserExternalEffect: vi.fn(),
  withUserWriteFence: vi.fn(),
  MockAccountErasureUserFencedError: class MockAccountErasureUserFencedError extends Error {
    constructor(cause?: unknown) {
      super("Account deletion is active for this user.", { cause });
      this.name = "AccountErasureUserFencedError";
    }
  },
}));

vi.mock("@sentry/node", () => ({ captureException: mocks.captureException }));
vi.mock("dofek/db/account-erasure", () => ({
  AccountErasureUserFencedError: mocks.MockAccountErasureUserFencedError,
  withAccountErasureUserWriteFence: mocks.withUserWriteFence,
}));
vi.mock("dofek/db/user-external-effect", () => ({
  recordUserExternalEffect: mocks.recordUserExternalEffect,
}));
vi.mock("dofek/zoho-desk", () => ({
  getZohoDeskClient: () => ({
    createTicket: mocks.createTicket,
    deleteTicket: mocks.deleteTicket,
  }),
}));
vi.mock("../logger.ts", () => ({
  logger: {
    error: mocks.loggerError,
    info: mocks.loggerInfo,
  },
}));

import { supportRouter } from "./support.ts";
import { createTestCallerFactory } from "./test-helpers.ts";

const userId = "00000000-0000-4000-8000-0000000000e1";
const transaction = {
  select: vi.fn(() => ({
    from: vi.fn(() => ({
      where: vi.fn(() => ({
        limit: vi.fn(async () => [{ email: "support@example.test", name: "Support User" }]),
      })),
    })),
  })),
};

describe("supportRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createTicket.mockResolvedValue({ id: "ticket-1", ticketNumber: "42" });
    mocks.deleteTicket.mockResolvedValue(undefined);
    mocks.recordUserExternalEffect.mockResolvedValue(undefined);
  });

  it("deletes the Zoho ticket when the fenced transaction fails to commit", async () => {
    mocks.withUserWriteFence.mockImplementationOnce(
      async (
        _database: unknown,
        _userId: string,
        operation: (database: typeof transaction) => Promise<unknown>,
      ) => {
        await operation(transaction);
        throw new Error("commit failed");
      },
    );
    const caller = createTestCallerFactory(supportRouter)({
      appVersion: "1.0.0",
      db: {},
      userId,
    });

    await expect(
      caller.createTicket({ message: "Please help", subject: "Support" }),
    ).rejects.toMatchObject({ code: "BAD_GATEWAY" });

    expect(mocks.recordUserExternalEffect).toHaveBeenCalledWith(transaction, {
      externalId: "ticket-1",
      resourceType: "ticket",
      system: "zoho_desk",
      userId,
      contactEmail: "support@example.test",
    });
    expect(mocks.deleteTicket).toHaveBeenCalledWith("ticket-1");
  });

  it("cleans up and returns a conflict without emitting IDs when account erasure wins the race", async () => {
    const databaseCause = Object.assign(new Error(`Account erasure is active for user ${userId}`), {
      code: "55000",
    });
    mocks.withUserWriteFence.mockImplementationOnce(
      async (
        _database: unknown,
        _userId: string,
        operation: (database: typeof transaction) => Promise<unknown>,
      ) => {
        await operation(transaction);
        throw new mocks.MockAccountErasureUserFencedError(databaseCause);
      },
    );
    const caller = createTestCallerFactory(supportRouter)({
      appVersion: "1.0.0",
      db: {},
      userId,
    });

    await expect(
      caller.createTicket({ message: "Please help", subject: "Support" }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Account deletion is active for this user.",
    });

    expect(mocks.deleteTicket).toHaveBeenCalledWith("ticket-1");
    expect(mocks.captureException).not.toHaveBeenCalled();
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain(userId);
    expect(JSON.stringify(mocks.loggerInfo.mock.calls)).not.toContain(userId);
    expect(JSON.stringify(mocks.loggerInfo.mock.calls)).not.toContain("ticket-1");
  });

  it("reports an orphan-ticket cleanup failure without account or ticket identifiers", async () => {
    mocks.withUserWriteFence.mockImplementationOnce(
      async (
        _database: unknown,
        _userId: string,
        operation: (database: typeof transaction) => Promise<unknown>,
      ) => {
        await operation(transaction);
        throw new Error(`commit failed for ${userId}`);
      },
    );
    mocks.deleteTicket.mockRejectedValueOnce(new Error("delete ticket-1 failed"));
    const caller = createTestCallerFactory(supportRouter)({
      appVersion: "1.0.0",
      db: {},
      userId,
    });

    await expect(
      caller.createTicket({ message: "Please help", subject: "Support" }),
    ).rejects.toMatchObject({ code: "BAD_GATEWAY" });

    const telemetry = JSON.stringify(mocks.captureException.mock.calls);
    expect(telemetry).not.toContain(userId);
    expect(telemetry).not.toContain("ticket-1");
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain(userId);
    expect(JSON.stringify(mocks.loggerError.mock.calls)).not.toContain("ticket-1");
  });
});
