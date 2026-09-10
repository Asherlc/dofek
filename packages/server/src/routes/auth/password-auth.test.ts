import type { Request, Response } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockRegisterPasswordUser,
  mockAuthenticatePasswordUser,
  mockCreateSession,
  mockSetSessionCookie,
  mockSanitizeReturnTo,
  mockCaptureException,
  mockLogger,
  mockCreatePasswordResetToken,
  mockResetPasswordWithToken,
  mockUserAndIdentityFence,
  mockUserWriteFence,
  MockAccountErasureIdentityFencedError,
  MockAccountErasureUserFencedError,
} = vi.hoisted(() => ({
  mockRegisterPasswordUser: vi.fn(),
  mockAuthenticatePasswordUser: vi.fn(),
  mockCreateSession: vi.fn(),
  mockSetSessionCookie: vi.fn(),
  mockSanitizeReturnTo: vi.fn((value: string | undefined) => {
    if (!value?.startsWith("/") || value.startsWith("//")) return undefined;
    return value;
  }),
  mockCaptureException: vi.fn(),
  mockLogger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() },
  mockCreatePasswordResetToken: vi.fn(),
  mockResetPasswordWithToken: vi.fn(),
  mockUserAndIdentityFence: vi.fn(),
  mockUserWriteFence: vi.fn(),
  MockAccountErasureIdentityFencedError: class MockAccountErasureIdentityFencedError extends Error {
    constructor() {
      super("Account deletion is active for this identity.");
      this.name = "AccountErasureIdentityFencedError";
    }
  },
  MockAccountErasureUserFencedError: class MockAccountErasureUserFencedError extends Error {
    constructor(cause?: unknown) {
      super("Account deletion is active for this user.", { cause });
      this.name = "AccountErasureUserFencedError";
    }
  },
}));

vi.mock("dofek/db/account-erasure", () => ({
  AccountErasureIdentityFencedError: MockAccountErasureIdentityFencedError,
  AccountErasureUserFencedError: MockAccountErasureUserFencedError,
  withAccountErasureUserAndIdentityWriteFence: (...args: unknown[]) =>
    mockUserAndIdentityFence(...args),
  withAccountErasureUserWriteFence: (...args: unknown[]) => mockUserWriteFence(...args),
}));

vi.mock("../../auth/password-credential.ts", () => ({
  registerPasswordUser: (...args: unknown[]) => mockRegisterPasswordUser(...args),
  authenticatePasswordUser: (...args: unknown[]) => mockAuthenticatePasswordUser(...args),
  DuplicateEmailError: class DuplicateEmailError extends Error {
    constructor() {
      super("Unable to create an account with these details");
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

vi.mock("../../auth/password-reset.ts", () => ({
  createPasswordResetToken: (...args: unknown[]) => mockCreatePasswordResetToken(...args),
  resetPasswordWithToken: (...args: unknown[]) => mockResetPasswordWithToken(...args),
  InvalidPasswordResetTokenError: class InvalidPasswordResetTokenError extends Error {
    constructor() {
      super("Reset link is invalid or has expired");
      this.name = "InvalidPasswordResetTokenError";
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
  getPostLoginRedirect: (value: string | undefined, isNewUser: boolean) =>
    mockSanitizeReturnTo(value) ?? (isNewUser ? "/?newUser=true" : "/"),
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
import { InvalidPasswordResetTokenError } from "../../auth/password-reset.ts";
import {
  handlePasswordLogin,
  handlePasswordRegister,
  handlePasswordResetConfirm,
  handlePasswordResetRequest,
} from "./password-auth.ts";

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
    mockCreateSession.mockResolvedValue({
      sessionId: "sess-register",
      expiresAt: new Date("2027-01-01"),
    });
    mockRegisterPasswordUser.mockResolvedValue({ userId: "user-1", isNewUser: true });
    mockUserAndIdentityFence.mockImplementation(
      async (
        database: unknown,
        _userId: string,
        _identities: unknown,
        operation: (transaction: unknown) => Promise<unknown>,
      ) => operation(database),
    );
    mockUserWriteFence.mockImplementation(
      async (
        database: unknown,
        _userId: string,
        operation: (transaction: unknown) => Promise<unknown>,
      ) => operation(database),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
    expect(mockUserAndIdentityFence).toHaveBeenCalledWith(
      {},
      expect.any(String),
      [{ email: "user@example.com", kind: "email" }],
      expect.any(Function),
    );
    expect(mockSetSessionCookie).toHaveBeenCalledWith(res, "sess-register", new Date("2027-01-01"));
    expect(res.json).toHaveBeenCalledWith({
      session: "sess-register",
      redirect: "/?newUser=true",
      isNewUser: true,
    });
  });

  it("returns a conflict when the registration identity is fenced", async () => {
    mockUserAndIdentityFence.mockRejectedValueOnce(new MockAccountErasureIdentityFencedError());
    const { req, res } = createMockReqRes({
      body: { email: "user@example.com", password: "password123" },
      headers: { accept: "application/json" },
    });

    await handlePasswordRegister(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      error: "Account deletion is active for this identity.",
    });
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it("marks new registrations in the default redirect", async () => {
    const { req, res } = createMockReqRes({
      body: { email: "user@example.com", password: "password123", name: "User" },
      headers: { accept: "application/json" },
    });

    await handlePasswordRegister(req, res);

    expect(res.json).toHaveBeenCalledWith({
      session: "sess-register",
      redirect: "/?newUser=true",
      isNewUser: true,
    });
  });

  it("redirects new users to onboarding marker when json is not requested", async () => {
    const { req, res } = createMockReqRes({
      body: { email: "user@example.com", password: "password123", return_to: "/onboarding" },
    });

    await handlePasswordRegister(req, res);

    expect(res.redirect).toHaveBeenCalledWith("/?newUser=true");
  });

  it("redirects new users to onboarding when no return path is set", async () => {
    const { req, res } = createMockReqRes({
      body: { email: "user@example.com", password: "password123" },
    });

    await handlePasswordRegister(req, res);

    expect(res.redirect).toHaveBeenCalledWith("/?newUser=true");
  });

  it("ignores return paths for html registration redirects", async () => {
    const { req, res } = createMockReqRes({
      body: { email: "user@example.com", password: "password123", return_to: "https://evil.com" },
    });

    await handlePasswordRegister(req, res);

    expect(res.redirect).toHaveBeenCalledWith("/?newUser=true");
  });

  it("includes sanitized return path in registration json response", async () => {
    const { req, res } = createMockReqRes({
      body: { email: "user@example.com", password: "password123", return_to: "/onboarding" },
      headers: { accept: "application/json" },
    });

    await handlePasswordRegister(req, res);

    expect(res.json).toHaveBeenCalledWith({
      session: "sess-register",
      redirect: "/onboarding",
      isNewUser: true,
    });
  });

  it("drops unsafe return paths from registration json response", async () => {
    const { req, res } = createMockReqRes({
      body: { email: "user@example.com", password: "password123", return_to: "//evil.com" },
      headers: { accept: "application/json" },
    });

    await handlePasswordRegister(req, res);

    expect(res.json).toHaveBeenCalledWith({
      session: "sess-register",
      redirect: "/?newUser=true",
      isNewUser: true,
    });
  });

  it("prefers query return_to over body return_to in registration json response", async () => {
    const { req, res } = createMockReqRes({
      body: { email: "user@example.com", password: "password123", return_to: "/from-body" },
      query: { return_to: "/from-query" },
      headers: { accept: "application/json" },
    });

    await handlePasswordRegister(req, res);

    expect(res.json).toHaveBeenCalledWith({
      session: "sess-register",
      redirect: "/from-query",
      isNewUser: true,
    });
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

  it("returns a generic error for an email that cannot be registered", async () => {
    mockRegisterPasswordUser.mockRejectedValue(new DuplicateEmailError());
    const { req, res } = createMockReqRes({
      body: { email: "user@example.com", password: "password123" },
      headers: { accept: "application/json" },
    });

    await handlePasswordRegister(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      error: "Unable to create an account with these details",
    });
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
    mockCreateSession.mockResolvedValue({
      sessionId: "sess-login",
      expiresAt: new Date("2027-01-01"),
    });
    mockAuthenticatePasswordUser.mockResolvedValue({ userId: "user-1" });
    mockUserWriteFence.mockImplementation(
      async (
        database: unknown,
        _userId: string,
        operation: (transaction: unknown) => Promise<unknown>,
      ) => operation(database),
    );
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
      isNewUser: false,
    });
  });

  it("returns a conflict without reporting an account-erasure write fence", async () => {
    const userId = "10000000-0000-4000-8000-000000001994";
    mockUserWriteFence.mockRejectedValueOnce(
      new MockAccountErasureUserFencedError(
        Object.assign(new Error(`Account erasure is active for user ${userId}`), {
          code: "55000",
        }),
      ),
    );
    const { req, res } = createMockReqRes({
      body: { email: "user@example.com", password: "password123" },
      headers: { accept: "application/json" },
    });

    await handlePasswordLogin(req, res);

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      error: "Account deletion is active for this user.",
    });
    expect(mockCaptureException).not.toHaveBeenCalled();
    expect(JSON.stringify(mockLogger.error.mock.calls)).not.toContain(userId);
  });

  it("redirects to home after login when json is not requested", async () => {
    const { req, res } = createMockReqRes({
      body: { email: "user@example.com", password: "password123" },
      query: { return_to: "/dashboard" },
    });

    await handlePasswordLogin(req, res);

    expect(res.redirect).toHaveBeenCalledWith("/");
  });

  it("redirects returning users to home when no return path is set", async () => {
    const { req, res } = createMockReqRes({
      body: { email: "user@example.com", password: "password123" },
    });

    await handlePasswordLogin(req, res);

    expect(res.redirect).toHaveBeenCalledWith("/");
  });

  it("ignores return paths for html login redirects", async () => {
    const { req, res } = createMockReqRes({
      body: { email: "user@example.com", password: "password123", return_to: "https://evil.com" },
    });

    await handlePasswordLogin(req, res);

    expect(res.redirect).toHaveBeenCalledWith("/");
  });

  it("includes sanitized return path in login json response", async () => {
    const { req, res } = createMockReqRes({
      body: { email: "user@example.com", password: "password123", return_to: "/dashboard" },
      headers: { accept: "application/json" },
    });

    await handlePasswordLogin(req, res);

    expect(res.json).toHaveBeenCalledWith({
      session: "sess-login",
      redirect: "/dashboard",
      isNewUser: false,
    });
  });

  it("drops unsafe return paths from login json response", async () => {
    const { req, res } = createMockReqRes({
      body: { email: "user@example.com", password: "password123", return_to: "//evil.com" },
      headers: { accept: "application/json" },
    });

    await handlePasswordLogin(req, res);

    expect(res.json).toHaveBeenCalledWith({
      session: "sess-login",
      redirect: "/",
      isNewUser: false,
    });
  });

  it("prefers query return_to over body return_to in login json response", async () => {
    const { req, res } = createMockReqRes({
      body: { email: "user@example.com", password: "password123", return_to: "/from-body" },
      query: { return_to: "/from-query" },
      headers: { accept: "application/json" },
    });

    await handlePasswordLogin(req, res);

    expect(res.json).toHaveBeenCalledWith({
      session: "sess-login",
      redirect: "/from-query",
      isNewUser: false,
    });
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

describe("handlePasswordResetRequest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreatePasswordResetToken.mockResolvedValue({ sent: true, token: "reset-token" });
  });

  it("returns generic success for password reset requests", async () => {
    const { req, res } = createMockReqRes({
      body: { email: "user@example.com" },
      headers: { accept: "application/json" },
    });

    await handlePasswordResetRequest(req, res);

    expect(mockCreatePasswordResetToken).toHaveBeenCalledWith({}, "user@example.com");
    expect(res.json).toHaveBeenCalledWith({
      message: "If that email has a password login, we'll send a reset link.",
    });
  });

  it("returns 400 for invalid reset request body", async () => {
    const { req, res } = createMockReqRes({
      body: { email: "not-an-email" },
      headers: { accept: "application/json" },
    });

    await handlePasswordResetRequest(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "Invalid password reset request" });
  });

  it("returns 500 and reports unexpected reset request errors", async () => {
    const error = new Error("database unavailable");
    mockCreatePasswordResetToken.mockRejectedValue(error);
    const { req, res } = createMockReqRes({
      body: { email: "user@example.com" },
      headers: { accept: "application/json" },
    });

    await handlePasswordResetRequest(req, res);

    expect(mockCaptureException).toHaveBeenCalledWith(error);
    expect(mockLogger.error).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      error: "Password reset request failed — please try again",
    });
  });
});

describe("handlePasswordResetConfirm", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResetPasswordWithToken.mockResolvedValue(undefined);
  });

  it("confirms a password reset token", async () => {
    const { req, res } = createMockReqRes({
      body: { token: "reset-token", password: "new-password123" },
      headers: { accept: "application/json" },
    });

    await handlePasswordResetConfirm(req, res);

    expect(mockResetPasswordWithToken).toHaveBeenCalledWith({}, "reset-token", "new-password123");
    expect(res.json).toHaveBeenCalledWith({ ok: true });
  });

  it("returns 400 for invalid reset confirmation body", async () => {
    const { req, res } = createMockReqRes({
      body: { token: "", password: "short" },
      headers: { accept: "application/json" },
    });

    await handlePasswordResetConfirm(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "Invalid password reset details" });
  });

  it("returns 400 for invalid reset tokens", async () => {
    mockResetPasswordWithToken.mockRejectedValue(new InvalidPasswordResetTokenError());
    const { req, res } = createMockReqRes({
      body: { token: "reset-token", password: "new-password123" },
      headers: { accept: "application/json" },
    });

    await handlePasswordResetConfirm(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "Reset link is invalid or has expired" });
  });

  it("returns 400 for weak passwords", async () => {
    mockResetPasswordWithToken.mockRejectedValue(
      new InvalidPasswordError("Password must be at least 8 characters"),
    );
    const { req, res } = createMockReqRes({
      body: { token: "reset-token", password: "short" },
      headers: { accept: "application/json" },
    });

    await handlePasswordResetConfirm(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith({ error: "Password must be at least 8 characters" });
  });

  it("returns 500 and reports unexpected reset confirmation errors", async () => {
    const error = new Error("database unavailable");
    mockResetPasswordWithToken.mockRejectedValue(error);
    const { req, res } = createMockReqRes({
      body: { token: "reset-token", password: "new-password123" },
      headers: { accept: "application/json" },
    });

    await handlePasswordResetConfirm(req, res);

    expect(mockCaptureException).toHaveBeenCalledWith(error);
    expect(mockLogger.error).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({ error: "Password reset failed — please try again" });
  });
});
