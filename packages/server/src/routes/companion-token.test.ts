import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockAuthenticatePasswordUser,
  mockCaptureException,
  mockLogger,
  mockRegenerateCompanionToken,
  mockWithUserWriteFence,
  MockAccountErasureUserFencedError,
} = vi.hoisted(() => ({
  mockAuthenticatePasswordUser: vi.fn(),
  mockCaptureException: vi.fn(),
  mockLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  mockRegenerateCompanionToken: vi.fn(),
  mockWithUserWriteFence: vi.fn(),
  MockAccountErasureUserFencedError: class MockAccountErasureUserFencedError extends Error {
    constructor(cause?: unknown) {
      super("Account deletion is active for this user.", { cause });
      this.name = "AccountErasureUserFencedError";
    }
  },
}));

vi.mock("dofek/db/account-erasure", () => ({
  AccountErasureUserFencedError: MockAccountErasureUserFencedError,
  withAccountErasureUserWriteFence: (...args: unknown[]) => mockWithUserWriteFence(...args),
}));

vi.mock("../auth/password-credential.ts", () => ({
  authenticatePasswordUser: (...args: unknown[]) => mockAuthenticatePasswordUser(...args),
  InvalidCredentialsError: class InvalidCredentialsError extends Error {
    constructor() {
      super("Invalid email or password");
      this.name = "InvalidCredentialsError";
    }
  },
}));

vi.mock("../companion/token-repository.ts", () => ({
  regenerateCompanionTokenInTransaction: (...args: unknown[]) =>
    mockRegenerateCompanionToken(...args),
}));

vi.mock("@sentry/node", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

vi.mock("../logger.ts", () => ({
  logger: mockLogger,
}));

import { InvalidCredentialsError } from "../auth/password-credential.ts";
import { createCompanionTokenHttpRouter } from "./companion-token.ts";

const transaction = { execute: vi.fn() };

function createTestApp() {
  const app = express();
  const db = {} satisfies import("dofek/db").Database;
  app.use("/api/companion-token", createCompanionTokenHttpRouter({ db }));
  return { app, db };
}

async function postJson(
  app: express.Express,
  path: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, async () => {
      const address = server.address();
      if (address === null || typeof address !== "object") {
        reject(new Error("Test server did not bind to a port"));
        return;
      }

      try {
        const response = await fetch(`http://localhost:${address.port}${path}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        const responseBody: unknown = await response.json();
        resolve({ status: response.status, body: responseBody });
      } catch (error) {
        reject(error);
      } finally {
        server.close();
      }
    });
  });
}

describe("createCompanionTokenHttpRouter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthenticatePasswordUser.mockResolvedValue({ userId: "user-1" });
    mockRegenerateCompanionToken.mockResolvedValue({
      id: "token-1",
      token: "dofek_companion_test",
      createdAt: "2026-07-12T00:00:00.000Z",
      revokedAt: null,
    });
    mockWithUserWriteFence.mockImplementation(
      async (
        _database: unknown,
        _userId: string,
        operation: (database: typeof transaction) => Promise<unknown>,
      ) => operation(transaction),
    );
  });

  it("returns 400 for invalid login details", async () => {
    const { app } = createTestApp();

    const response = await postJson(app, "/api/companion-token/password-login", {
      email: "not-an-email",
      password: "password123",
    });

    expect(response).toEqual({
      status: 400,
      body: { error: "Invalid login details" },
    });
    expect(mockAuthenticatePasswordUser).not.toHaveBeenCalled();
  });

  it("returns 401 for invalid credentials", async () => {
    mockAuthenticatePasswordUser.mockRejectedValue(new InvalidCredentialsError());
    const { app } = createTestApp();

    const response = await postJson(app, "/api/companion-token/password-login", {
      email: "user@example.com",
      password: "wrong-password",
    });

    expect(response).toEqual({
      status: 401,
      body: { error: "Invalid email or password" },
    });
  });

  it("regenerates and returns a companion token after password login", async () => {
    const { app, db } = createTestApp();

    const response = await postJson(app, "/api/companion-token/password-login", {
      email: "user@example.com",
      password: "password123",
    });

    expect(mockAuthenticatePasswordUser).toHaveBeenCalledWith(
      db,
      "user@example.com",
      "password123",
    );
    expect(mockWithUserWriteFence).toHaveBeenCalledWith(db, "user-1", expect.any(Function));
    expect(mockRegenerateCompanionToken).toHaveBeenCalledWith(transaction, "user-1");
    expect(response).toEqual({
      status: 200,
      body: {
        id: "token-1",
        token: "dofek_companion_test",
        createdAt: "2026-07-12T00:00:00.000Z",
        revokedAt: null,
      },
    });
  });

  it("returns a conflict without reporting an account-erasure write fence", async () => {
    const userId = "10000000-0000-4000-8000-000000001994";
    mockWithUserWriteFence.mockRejectedValueOnce(
      new MockAccountErasureUserFencedError(
        Object.assign(new Error(`Account erasure is active for user ${userId}`), {
          code: "55000",
        }),
      ),
    );
    const { app } = createTestApp();

    const response = await postJson(app, "/api/companion-token/password-login", {
      email: "user@example.com",
      password: "password123",
    });

    expect(response).toEqual({
      status: 409,
      body: { error: "Account deletion is active for this user." },
    });
    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(JSON.stringify(mockLogger.error.mock.calls)).not.toContain(userId);
  });

  it("reports unexpected token creation failures", async () => {
    mockRegenerateCompanionToken.mockResolvedValue({
      id: "token-1",
      token: null,
      createdAt: "2026-07-12T00:00:00.000Z",
      revokedAt: null,
    });
    const { app } = createTestApp();

    const response = await postJson(app, "/api/companion-token/password-login", {
      email: "user@example.com",
      password: "password123",
    });

    expect(mockCaptureException).toHaveBeenCalled();
    expect(response).toEqual({
      status: 500,
      body: { error: "Failed to create Dofek connection." },
    });
  });
});
