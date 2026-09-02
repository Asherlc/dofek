import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

const {
  MockPostHogConversationsError,
  mockCaptureException,
  mockCreateTicket,
  mockLoggerError,
  mockLoggerInfo,
  mockWithUserWriteFence,
  MockAccountErasureUserFencedError,
} = vi.hoisted(() => {
  class MockPostHogConversationsError extends Error {
    readonly status: number;

    constructor(message: string, status: number) {
      super(message);
      this.name = "PostHogConversationsError";
      this.status = status;
    }
  }

  class MockAccountErasureUserFencedError extends Error {
    constructor(cause?: unknown) {
      super("Account deletion is active for this user.", { cause });
      this.name = "AccountErasureUserFencedError";
    }
  }

  return {
    MockPostHogConversationsError,
    mockCaptureException: vi.fn(),
    mockCreateTicket: vi.fn(),
    mockLoggerError: vi.fn(),
    mockLoggerInfo: vi.fn(),
    mockWithUserWriteFence: vi.fn(),
    MockAccountErasureUserFencedError,
  };
});

vi.mock("dofek/db/account-erasure", () => ({
  AccountErasureUserFencedError: MockAccountErasureUserFencedError,
  withAccountErasureUserWriteFence: (...args: unknown[]) => mockWithUserWriteFence(...args),
}));

vi.mock("../trpc.ts", async () => {
  const { initTRPC } = await import("@trpc/server");
  const trpc = initTRPC.context<{ db: unknown; userId: string; appVersion?: string }>().create();
  return {
    router: trpc.router,
    protectedProcedure: trpc.procedure,
  };
});

vi.mock("dofek/db/schema/reference", () => ({
  userProfile: { id: "id", name: "name", email: "email" },
}));

vi.mock("dofek/lib/error-reporting", () => ({
  captureException: mockCaptureException,
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
}));

vi.mock("../lib/posthog-conversations.ts", () => ({
  getPostHogConversationsClient: () => ({ createTicket: mockCreateTicket }),
  PostHogConversationsError: MockPostHogConversationsError,
}));

vi.mock("../logger.ts", () => ({
  logger: {
    error: mockLoggerError,
    info: mockLoggerInfo,
  },
}));

import { supportRouter } from "./support.ts";

const createCaller = createTestCallerFactory(supportRouter);

type Profile = { name: string | null; email: string | null };

function makeDb(profile?: Profile) {
  const limit = vi.fn().mockResolvedValue(profile ? [profile] : []);
  const where = vi.fn().mockReturnValue({ limit });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn((projection: unknown) => {
    expect(projection).toEqual({ name: "name", email: "email" });
    return { from };
  });
  return {
    select,
  };
}

function makeCaller(profile?: Profile, appVersion?: string) {
  return createCaller({
    db: makeDb(profile),
    userId: "user-1",
    appVersion,
  });
}

const ticketInput = {
  subject: "Sync broke",
  message: "Activities stopped importing.",
};

const statusCases = [
  {
    status: 200,
    code: "BAD_GATEWAY" as const,
    message: "PostHog Support Tickets is unavailable. Please try again shortly.",
  },
  {
    status: 400,
    code: "BAD_REQUEST" as const,
    message: "Support Tickets rejected the request. Review your message and try again.",
  },
  {
    status: 408,
    code: "GATEWAY_TIMEOUT" as const,
    message: "Support Tickets timed out. Please try again shortly.",
  },
  {
    status: 399,
    code: "BAD_GATEWAY" as const,
    message: "PostHog Support Tickets is unavailable. Please try again shortly.",
  },
  {
    status: 401,
    code: "SERVICE_UNAVAILABLE" as const,
    message:
      "Support Tickets could not authenticate this request. Please contact the administrator.",
  },
  {
    status: 403,
    code: "SERVICE_UNAVAILABLE" as const,
    message:
      "Support Tickets could not authenticate this request. Please contact the administrator.",
  },
  {
    status: 422,
    code: "UNPROCESSABLE_CONTENT" as const,
    message: "Support Tickets rejected the request. Review your message and try again.",
  },
  {
    status: 429,
    code: "TOO_MANY_REQUESTS" as const,
    message: "Support Tickets is rate-limited. Please wait a moment before trying again.",
  },
  {
    status: 503,
    code: "SERVICE_UNAVAILABLE" as const,
    message: "Support Tickets is not available for this project. Please contact the administrator.",
  },
  {
    status: 504,
    code: "GATEWAY_TIMEOUT" as const,
    message: "Support Tickets timed out. Please try again shortly.",
  },
  {
    status: 500,
    code: "BAD_GATEWAY" as const,
    message: "PostHog Support Tickets is unavailable. Please try again shortly.",
  },
] as const;

describe("supportRouter", () => {
  beforeEach(() => {
    mockCaptureException.mockReset();
    mockCreateTicket.mockReset();
    mockLoggerError.mockReset();
    mockLoggerInfo.mockReset();
    mockWithUserWriteFence.mockReset();
    mockWithUserWriteFence.mockImplementation(
      async (
        database: unknown,
        _userId: string,
        operation: (database: unknown) => Promise<unknown>,
      ) => operation(database),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("creates a ticket with profile context", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => "widget-session-1" });
    mockCreateTicket.mockResolvedValue({ ticketId: "ticket-1" });

    await expect(
      makeCaller({ name: "Support User", email: "user@example.com" }).createTicket(ticketInput),
    ).resolves.toEqual({ ticketId: "ticket-1" });

    expect(mockCreateTicket).toHaveBeenCalledWith({
      message: expect.stringContaining("Subject: Sync broke"),
      contactEmail: "user@example.com",
      contactName: "Support User",
      distinctId: "user-1",
      widgetSessionId: "widget-session-1",
    });
    expect(mockCreateTicket.mock.calls[0]?.[0]).toMatchObject({
      message: expect.stringContaining("App version: unknown"),
    });
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      "[support] ticket created userId=user-1 ticketId=ticket-1",
    );
  });

  it("returns a conflict when account erasure fences ticket creation", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => "widget-session-1" });
    mockCreateTicket.mockResolvedValue({ ticketId: "ticket-1" });
    mockWithUserWriteFence.mockImplementationOnce(
      async (
        database: unknown,
        _userId: string,
        operation: (database: unknown) => Promise<unknown>,
      ) => {
        await operation(database);
        throw new MockAccountErasureUserFencedError();
      },
    );

    await expect(
      makeCaller({ name: "Support User", email: "user@example.com" }).createTicket(ticketInput),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "Account deletion is active for this user.",
    });
    expect(mockCaptureException).not.toHaveBeenCalled();
  });

  it.each(statusCases)(
    "maps PostHog status $status to $code",
    async ({ status, code, message }) => {
      mockCreateTicket.mockRejectedValue(
        new MockPostHogConversationsError("upstream failure", status),
      );

      await expect(
        makeCaller({ name: "Support User", email: "user@example.com" }).createTicket(ticketInput),
      ).rejects.toMatchObject({ code, message });
      expect(mockCaptureException).toHaveBeenCalledTimes(
        status >= 500 || status < 300 || status === 401 || status === 403 || status === 408 ? 1 : 0,
      );
      expect(mockLoggerError).toHaveBeenCalledTimes(1);
    },
  );

  it("maps non-PostHog failures to a retryable gateway error", async () => {
    mockCreateTicket.mockRejectedValue(new Error("network unavailable"));

    await expect(
      makeCaller({ name: "Support User", email: "user@example.com" }).createTicket(ticketInput),
    ).rejects.toMatchObject({
      code: "BAD_GATEWAY",
      message: "PostHog Support Tickets is unavailable. Please try again shortly.",
    });
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
    expect(mockLoggerError).toHaveBeenCalledTimes(1);
  });

  it("does not trust status fields on non-PostHog errors", async () => {
    const error = Object.assign(new Error("network unavailable"), { status: 400 });
    mockCreateTicket.mockRejectedValue(error);

    await expect(
      makeCaller({ name: "Support User", email: "user@example.com" }).createTicket(ticketInput),
    ).rejects.toMatchObject({ code: "BAD_GATEWAY" });
  });

  it("requires an email before contacting PostHog", async () => {
    await expect(makeCaller().createTicket(ticketInput)).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
    });
    expect(mockCreateTicket).not.toHaveBeenCalled();
  });

  it("rejects messages whose enriched description exceeds PostHog's limit", async () => {
    await expect(
      makeCaller(
        { name: "Support User", email: "user@example.com" },
        "x".repeat(1_000),
      ).createTicket({
        ...ticketInput,
        message: "x".repeat(4_000),
      }),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "Support message is too long after context is added. Shorten it and try again.",
    });
    expect(mockCreateTicket).not.toHaveBeenCalled();
  });

  it("allows an enriched description exactly at PostHog's limit", async () => {
    const message = "x".repeat(4_000);
    const descriptionWithoutAppVersion = [
      `Subject: ${ticketInput.subject}`,
      "",
      message,
      "",
      "---",
      "User ID: user-1",
      "App version: ",
    ].join("\n");
    const appVersion = "🙂".repeat(5_000 - [...descriptionWithoutAppVersion].length);
    mockCreateTicket.mockResolvedValue({ ticketId: "ticket-limit" });

    await expect(
      makeCaller({ name: "Support User", email: "user@example.com" }, appVersion).createTicket({
        ...ticketInput,
        message,
      }),
    ).resolves.toEqual({ ticketId: "ticket-limit" });

    expect(mockCreateTicket).toHaveBeenCalledTimes(1);
    const request = mockCreateTicket.mock.calls[0]?.[0];
    expect(request).toBeDefined();
    if (
      !request ||
      typeof request !== "object" ||
      !("message" in request) ||
      typeof request.message !== "string"
    ) {
      throw new Error("Expected PostHog request message");
    }
    expect([...request.message]).toHaveLength(5_000);
  });

  it("uses the explicit email when the profile is missing", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => "widget-session-2" });
    mockCreateTicket.mockResolvedValue({ ticketId: "ticket-2" });

    await expect(
      makeCaller().createTicket({ ...ticketInput, email: "explicit@example.com" }),
    ).resolves.toEqual({ ticketId: "ticket-2" });

    expect(mockCreateTicket).toHaveBeenCalledWith(
      expect.objectContaining({
        contactEmail: "explicit@example.com",
        contactName: "explicit@example.com",
      }),
    );
  });
});
