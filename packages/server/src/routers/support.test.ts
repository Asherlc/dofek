import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestCallerFactory } from "./test-helpers.ts";

const {
  MockPostHogConversationsError,
  mockCaptureException,
  mockCreateTicket,
  mockLoggerError,
  mockLoggerInfo,
} = vi.hoisted(() => {
  class MockPostHogConversationsError extends Error {
    readonly status: number;

    constructor(message: string, status: number) {
      super(message);
      this.name = "PostHogConversationsError";
      this.status = status;
    }
  }

  return {
    MockPostHogConversationsError,
    mockCaptureException: vi.fn(),
    mockCreateTicket: vi.fn(),
    mockLoggerError: vi.fn(),
    mockLoggerInfo: vi.fn(),
  };
});

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
    status: 400,
    code: "BAD_REQUEST" as const,
    message: "Support Tickets rejected the request. Review your message and try again.",
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

  it.each(statusCases)("maps PostHog status $status to $code", async ({
    status,
    code,
    message,
  }) => {
    mockCreateTicket.mockRejectedValue(
      new MockPostHogConversationsError("upstream failure", status),
    );

    await expect(
      makeCaller({ name: "Support User", email: "user@example.com" }).createTicket(ticketInput),
    ).rejects.toMatchObject({ code, message });
    expect(mockCaptureException).toHaveBeenCalledTimes(1);
  });

  it("maps non-PostHog failures to a retryable gateway error", async () => {
    mockCreateTicket.mockRejectedValue(new Error("network unavailable"));

    await expect(
      makeCaller({ name: "Support User", email: "user@example.com" }).createTicket(ticketInput),
    ).rejects.toMatchObject({
      code: "BAD_GATEWAY",
      message: "PostHog Support Tickets is unavailable. Please try again shortly.",
    });
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
    const appVersion = "x".repeat(5_000 - descriptionWithoutAppVersion.length);
    mockCreateTicket.mockResolvedValue({ ticketId: "ticket-limit" });

    await expect(
      makeCaller({ name: "Support User", email: "user@example.com" }, appVersion).createTicket({
        ...ticketInput,
        message,
      }),
    ).resolves.toEqual({ ticketId: "ticket-limit" });
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
