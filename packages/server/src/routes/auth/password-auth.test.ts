import type { Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockRegisterPasswordUser,
  mockAuthenticatePasswordUser,
  mockIsPasswordAuthEnabled,
  mockCreateSession,
  mockSetSessionCookie,
  mockSanitizeReturnTo,
  mockCaptureException,
  mockLogger,
} = vi.hoisted(() => ({
  mockRegisterPasswordUser: vi.fn(),
  mockAuthenticatePasswordUser: vi.fn(),
  mockIsPasswordAuthEnabled: vi.fn(() => true),
  mockCreateSession: vi.fn(),
  mockSetSessionCookie: vi.fn(),
  mockSanitizeReturnTo: vi.fn((value: string | undefined) => value),
  mockCaptureException: vi.fn(),
  mockLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
}));

vi.mock("../../auth/password-credential.ts", () => ({
  registerPasswordUser: (...args: unknown[]) => mockRegisterPasswordUser(...args),
  authenticatePasswordUser: (...args: unknown[]) => mockAuthenticatePasswordUser(...args),
  isPasswordAuthEnabled: () => mockIsPasswordAuthEnabled(),
  DuplicateEmailError: class DuplicateEmailError extends Error {
    constructor() {
      super("An account with this email already exists");
      this.name = "DuplicateEmailError";
    }
  },
  InvalidCredentialsError: class InvalidCredentialsError extends Error {
    constructor() {
      super("Invalid email or password");
      this.name = "InvalidCredentialsError";
    }
  },
}));

vi.mock("../../auth/password.ts", () => ({
  InvalidPasswordError: class InvalidPasswordError extends Error {
    constructor(message: string) {
      super(message);
      this.name = "InvalidPasswordError";
    }
  },
}));

vi.mock("../../auth/session.ts", () => ({
  createSession: (...args: unknown[]) => mockCreateSession(...args),
}));

vi.mock("../../auth/cookies.ts", () => ({
  setSessionCookie: (...args: unknown[]) => mockSetSessionCookie(...args),
}));

vi.mock("./shared.ts", () => ({
  getDb: () => ({}),
  sanitizeReturnTo: (value: string | undefined) => mockSanitizeReturnTo(value),
}));

vi.mock("@sentry/node", () => ({
  captureException: (...args: unknown[]) => mockCaptureException(...args),
}));

vi.mock("../../logger.ts", () => ({
  logger: mockLogger,
}));

import { InvalidPasswordError } from "../../auth/password.ts";
import { DuplicateEmailError, InvalidCredentialsError } from "../../auth/password-credential.ts";
import { handlePasswordLogin, handlePasswordRegister } from "./password-auth.ts";

function mockOf<T extends object>(partial: Partial<T>): T {
  return partial;
}

function createMockReqRes(options?: {
  body?: Record<string, unknown>;
  query?: Record<string, string>;
  headers?: Record<string, string | string[] | undefined>;
}): { req: Request; res: Response } {
  const req = mockOf<Request>({
    body: options?.body ?? {},
    query: options?.query ?? {},
    headers: options?.headers ?? {},
  });
  const res = mockOf<Response>({
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    redirect: vi.fn(),
  });
  return { req, res };
}

describe("handlePasswordRegister", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsPasswordAuthEnabled.mockReturnValue(true);
    mockCreateSession.mockResolvedValue({
      sessionId: "sess-register",
      expiresAt: new Date("2027-01-01"),
    });
    mockRegisterPasswordUser.mockResolvedValue({ userId: "user-1", isNewUser: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns 404 when password auth is disabled", async () => {
    mockIsPasswordAuthEnabled.mockReturnValue(false);
    const { req, res } = createMockReqRes();

    await handlePasswordRegister(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: "Password authentication is not enabled" });
  });

  it("returns 400 for invalid registration body", async () => {
    const { req, res } = createMockReqRes({
      body: { email: "not-an-email", password: "password123" },
      headers: { accept: "application/json" },
    });

    await handlePasswordRegister(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "Invalid registration details" });
  });

  it("returns session json for valid registration", async () => {
    const { req, res } = createMockReqRes({
      body: { email: "user@example.com", password: "password123", name: "User" },
      headers: { accept: "application/json" },
    });

    await handlePasswordRegister(req, res);

    expect(mockRegisterPasswordUser).toHaveBeenCalled();
    expect(mockSetSessionCookie).toHaveBeenCalledWith(res, "sess-register", new Date("2027-01-01"));
    expect(res.json).toHaveBeenCalledWith({
      session: "sess-register",
      redirect: "/",
    });
  });

  it("redirects to home after registration when json is not requested", async () => {
    const { req, res } = createMockReqRes({
      body: { email: "user@example.com", password: "password123", return_to: "/onboarding" },
    });

    await handlePasswordRegister(req, res);

    expect(res.redirect).toHaveBeenCalledWith("/");
  });

  it("uses content-type json to detect json responses", async () => {
    const { req, res } = createMockReqRes({
      body: { email: "user@example.com", password: "password123" },
      headers: { "content-type": "application/json" },
    });

    await handlePasswordRegister(req, res);

    expect(res.json).toHaveBeenCalled();
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it("returns 409 for duplicate email", async () => {
    mockRegisterPasswordUser.mockRejectedValue(new DuplicateEmailError());
    const { req, res } = createMockReqRes({
      body: { email: "user@example.com", password: "password123" },
      headers: { accept: "application/json" },
    });

    await handlePasswordRegister(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ error: "An account with this email already exists" });
  });

  it("returns 400 for weak password", async () => {
    mockRegisterPasswordUser.mockRejectedValue(
      new InvalidPasswordError("Password must be at least 8 characters"),
    );
    const { req, res } = createMockReqRes({
      body: { email: "user@example.com", password: "short" },
      headers: { accept: "application/json" },
    });

    await handlePasswordRegister(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({
      error: "Password must be at least 8 characters",
    });
  });

  it("returns 500 and reports unexpected registration errors", async () => {
    const error = new Error("database unavailable");
    mockRegisterPasswordUser.mockRejectedValue(error);
    const { req, res } = createMockReqRes({
      body: { email: "user@example.com", password: "password123" },
      headers: { accept: "application/json" },
    });

    await handlePasswordRegister(req, res);

    expect(mockCaptureException).toHaveBeenCalledWith(error);
    expect(mockLogger.error).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: "Registration failed — please try again",
    });
  });
});

describe("handlePasswordLogin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsPasswordAuthEnabled.mockReturnValue(true);
    mockCreateSession.mockResolvedValue({
      sessionId: "sess-login",
      expiresAt: new Date("2027-01-01"),
    });
    mockAuthenticatePasswordUser.mockResolvedValue({ userId: "user-1" });
  });

  it("returns 404 when password auth is disabled", async () => {
    mockIsPasswordAuthEnabled.mockReturnValue(false);
    const { req, res } = createMockReqRes();

    await handlePasswordLogin(req, res);

    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ error: "Password authentication is not enabled" });
  });

  it("returns 400 for invalid login body", async () => {
    const { req, res } = createMockReqRes({
      body: { email: "not-an-email", password: "password123" },
      headers: { accept: "application/json" },
    });

    await handlePasswordLogin(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "Invalid login details" });
  });

  it("returns session json for valid login", async () => {
    const { req, res } = createMockReqRes({
      body: { email: "user@example.com", password: "password123" },
      headers: { accept: "application/json" },
    });

    await handlePasswordLogin(req, res);

    expect(mockAuthenticatePasswordUser).toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({
      session: "sess-login",
      redirect: "/",
    });
  });

  it("redirects to home after login when json is not requested", async () => {
    const { req, res } = createMockReqRes({
      body: { email: "user@example.com", password: "password123" },
      query: { return_to: "/dashboard" },
    });

    await handlePasswordLogin(req, res);

    expect(res.redirect).toHaveBeenCalledWith("/");
  });

  it("returns 401 for invalid credentials", async () => {
    mockAuthenticatePasswordUser.mockRejectedValue(new InvalidCredentialsError());
    const { req, res } = createMockReqRes({
      body: { email: "user@example.com", password: "wrong-password" },
      headers: { accept: "application/json" },
    });

    await handlePasswordLogin(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: "Invalid email or password" });
  });

  it("returns 500 and reports unexpected login errors", async () => {
    const error = new Error("database unavailable");
    mockAuthenticatePasswordUser.mockRejectedValue(error);
    const { req, res } = createMockReqRes({
      body: { email: "user@example.com", password: "password123" },
      headers: { accept: "application/json" },
    });

    await handlePasswordLogin(req, res);

    expect(mockCaptureException).toHaveBeenCalledWith(error);
    expect(mockLogger.error).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Login failed — please try again" });
  });
});
