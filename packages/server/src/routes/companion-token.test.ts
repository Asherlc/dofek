import express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockAuthenticatePasswordUser,
  mockCaptureException,
  mockIsPasswordAuthEnabled,
  mockLogger,
  mockRegenerateCompanionToken,
} = vi.hoisted(() => ({
  mockAuthenticatePasswordUser: vi.fn(),
  mockCaptureException: vi.fn(),
  mockIsPasswordAuthEnabled: vi.fn(() => true),
  mockLogger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
  mockRegenerateCompanionToken: vi.fn(),
}));

vi.mock("../auth/password-credential.ts", () => ({
  authenticatePasswordUser: (...args: unknown[]) => mockAuthenticatePasswordUser(...args),
  isPasswordAuthEnabled: () => mockIsPasswordAuthEnabled(),
  InvalidCredentialsError: class InvalidCredentialsError extends Error {
    constructor() {
      super("Invalid email or password");
      this.name = "InvalidCredentialsError";
    }
  },
}));

vi.mock("../companion/token-repository.ts", () => ({
  regenerateCompanionToken: (...args: unknown[]) => mockRegenerateCompanionToken(...args),
}));

vi.mock("@sentry/node", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

vi.mock("../logger.ts", () => ({
  logger: mockLogger,
}));

import { InvalidCredentialsError } from "../auth/password-credential.ts";
import { createCompanionTokenHttpRouter } from "./companion-token.ts";

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
    mockIsPasswordAuthEnabled.mockReturnValue(true);
    mockAuthenticatePasswordUser.mockResolvedValue({ userId: "user-1" });
    mockRegenerateCompanionToken.mockResolvedValue({
      id: "token-1",
      token: "dofek_companion_test",
      createdAt: "2026-07-12T00:00:00.000Z",
      revokedAt: null,
    });
  });

  it("returns 404 when password auth is disabled", async () => {
    mockIsPasswordAuthEnabled.mockReturnValue(false);
    const { app } = createTestApp();

    const response = await postJson(app, "/api/companion-token/password-login", {
      email: "user@example.com",
      password: "password123",
    });

    expect(response).toEqual({
      status: 404,
      body: { error: "Password authentication is not enabled" },
    });
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
    expect(mockRegenerateCompanionToken).toHaveBeenCalledWith(db, "user-1");
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
      body: { error: "Failed to create companion token." },
    });
  });
});
