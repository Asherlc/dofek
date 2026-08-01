import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockSupportTicketDurationObserve, mockSupportTicketOperationsInc, mockCaptureException } =
  vi.hoisted(() => ({
    mockSupportTicketDurationObserve: vi.fn(),
    mockSupportTicketOperationsInc: vi.fn(),
    mockCaptureException: vi.fn(),
  }));

vi.mock("./metrics.ts", () => ({
  supportTicketDuration: { observe: mockSupportTicketDurationObserve },
  supportTicketOperationsTotal: { inc: mockSupportTicketOperationsInc },
}));

vi.mock("dofek/lib/error-reporting", () => ({
  captureException: mockCaptureException,
}));

import {
  getPostHogConversationsClient,
  PostHogConversationsClient,
  type PostHogConversationsConfig,
  PostHogConversationsError,
  type PostHogSupportTicketInput,
} from "./posthog-conversations.ts";

const config: PostHogConversationsConfig = {
  apiKey: "project-token",
  host: "https://posthog.example///",
};

const ticketInput: PostHogSupportTicketInput = {
  message: "  Help with Garmin sync  ",
  contactEmail: "user@example.com",
  contactName: "Asher",
  distinctId: "user-1",
  widgetSessionId: "widget-session-1",
};

let fetchMock: ReturnType<typeof vi.fn<typeof globalThis.fetch>>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function configResponse(token: string, enabled = true): Response {
  return jsonResponse({ conversations: { enabled, token } });
}

function ticketResponse(ticketId = "ticket-1"): Response {
  return jsonResponse({ ticket_id: ticketId });
}

function getFetchCall(index: number): [RequestInfo | URL, RequestInit | undefined] {
  const call = fetchMock.mock.calls[index];
  if (!call) {
    throw new Error(`Missing fetch call at index ${index}`);
  }
  return call;
}

beforeEach(() => {
  fetchMock = vi.fn<typeof globalThis.fetch>();
  vi.stubGlobal("fetch", fetchMock);
  mockSupportTicketDurationObserve.mockReset();
  mockSupportTicketOperationsInc.mockReset();
  mockCaptureException.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("PostHogConversationsClient", () => {
  it("loads the token and creates a ticket with the trimmed, encoded request", async () => {
    fetchMock.mockResolvedValueOnce(configResponse("conversation-token"));
    fetchMock.mockResolvedValueOnce(ticketResponse());

    const client = new PostHogConversationsClient({
      ...config,
      apiKey: "project token/1",
    });

    await expect(client.createTicket(ticketInput)).resolves.toEqual({ ticketId: "ticket-1" });

    const [configUrl, configInit] = getFetchCall(0);
    expect(configUrl).toBe("https://posthog.example/array/project%20token%2F1/config");
    expect(configInit).toEqual({
      headers: { Accept: "application/json" },
      signal: expect.any(AbortSignal),
    });

    const [messageUrl, messageInit] = getFetchCall(1);
    expect(messageUrl).toBe("https://posthog.example/api/conversations/v1/widget/message");
    expect(messageInit).toEqual({
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Conversations-Token": "conversation-token",
      },
      body: JSON.stringify({
        message: "Help with Garmin sync",
        traits: { name: "Asher", email: "user@example.com" },
        ticket_id: null,
        widget_session_id: "widget-session-1",
        distinct_id: "user-1",
      }),
      signal: expect.any(AbortSignal),
    });
    expect(mockSupportTicketOperationsInc).toHaveBeenCalledWith({
      outcome: "success",
      status_class: "2xx",
    });
    expect(mockSupportTicketDurationObserve).toHaveBeenCalledWith(
      { outcome: "success" },
      expect.any(Number),
    );
  });

  it("reuses a cached token until the configuration TTL expires", async () => {
    vi.useFakeTimers({ now: 1_000 });
    fetchMock
      .mockResolvedValueOnce(configResponse("token-1"))
      .mockResolvedValueOnce(ticketResponse("ticket-1"))
      .mockResolvedValueOnce(ticketResponse("ticket-2"))
      .mockResolvedValueOnce(configResponse("token-2"))
      .mockResolvedValueOnce(ticketResponse("ticket-3"));

    const client = new PostHogConversationsClient(config);
    await expect(client.createTicket(ticketInput)).resolves.toEqual({ ticketId: "ticket-1" });
    await expect(client.createTicket(ticketInput)).resolves.toEqual({ ticketId: "ticket-2" });
    vi.setSystemTime(301_000);
    await expect(client.createTicket(ticketInput)).resolves.toEqual({ ticketId: "ticket-3" });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(getFetchCall(4)[1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Conversations-Token": "token-2" }),
      }),
    );
  });

  it("records ticket latency in seconds", async () => {
    vi.spyOn(performance, "now").mockReturnValueOnce(1_000).mockReturnValueOnce(1_250);
    fetchMock.mockResolvedValueOnce(configResponse("conversation-token"));
    fetchMock.mockResolvedValueOnce(ticketResponse());

    await new PostHogConversationsClient(config).createTicket(ticketInput);

    expect(mockSupportTicketDurationObserve).toHaveBeenCalledWith({ outcome: "success" }, 0.25);
  });

  it("shares an in-flight config request across concurrent ticket submissions", async () => {
    let resolveConfig!: (response: Response) => void;
    const configPromise = new Promise<Response>((resolve) => {
      resolveConfig = resolve;
    });
    fetchMock.mockImplementation((input) => {
      if (String(input).endsWith("/config")) {
        return configPromise;
      }
      return Promise.resolve(ticketResponse());
    });

    const client = new PostHogConversationsClient(config);
    const firstTicket = client.createTicket(ticketInput);
    const secondTicket = client.createTicket(ticketInput);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveConfig(configResponse("conversation-token"));

    await expect(Promise.all([firstTicket, secondTicket])).resolves.toEqual([
      { ticketId: "ticket-1" },
      { ticketId: "ticket-1" },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("refreshes the cached token after 401 and 403 responses", async () => {
    for (const status of [401, 403]) {
      fetchMock.mockReset();
      fetchMock
        .mockResolvedValueOnce(configResponse(`token-${status}-1`))
        .mockResolvedValueOnce(jsonResponse({ detail: "expired" }, status))
        .mockResolvedValueOnce(configResponse(`token-${status}-2`))
        .mockResolvedValueOnce(ticketResponse(`ticket-${status}`));

      const client = new PostHogConversationsClient(config);

      await expect(client.createTicket(ticketInput)).resolves.toEqual({
        ticketId: `ticket-${status}`,
      });

      expect(getFetchCall(1)[1]).toEqual(
        expect.objectContaining({
          headers: expect.objectContaining({ "X-Conversations-Token": `token-${status}-1` }),
        }),
      );
      expect(getFetchCall(3)[1]).toEqual(
        expect.objectContaining({
          headers: expect.objectContaining({ "X-Conversations-Token": `token-${status}-2` }),
        }),
      );
    }
  });

  it("bounds retries when the refreshed token is also rejected", async () => {
    fetchMock
      .mockResolvedValueOnce(configResponse("token-1"))
      .mockResolvedValueOnce(jsonResponse({ detail: "expired" }, 401))
      .mockResolvedValueOnce(configResponse("token-2"))
      .mockResolvedValueOnce(jsonResponse({ detail: "expired" }, 401));

    const client = new PostHogConversationsClient(config);

    await expect(client.createTicket(ticketInput)).rejects.toMatchObject({
      status: 401,
      name: "PostHogConversationsError",
    });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("keeps the cached token after unrelated HTTP errors", async () => {
    fetchMock
      .mockResolvedValueOnce(configResponse("conversation-token"))
      .mockResolvedValueOnce(jsonResponse({ detail: "temporary failure" }, 500))
      .mockResolvedValueOnce(jsonResponse({ detail: "temporary failure" }, 500));

    const client = new PostHogConversationsClient(config);

    await expect(client.createTicket(ticketInput)).rejects.toMatchObject({ status: 500 });
    await expect(client.createTicket(ticketInput)).rejects.toMatchObject({ status: 500 });

    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(getFetchCall(2)[1]).toEqual(
      expect.objectContaining({
        headers: expect.objectContaining({ "X-Conversations-Token": "conversation-token" }),
      }),
    );
  });

  it("rejects when Support Tickets are disabled in object or boolean config", async () => {
    fetchMock
      .mockResolvedValueOnce(configResponse("conversation-token", false))
      .mockResolvedValueOnce(jsonResponse({ conversations: false }));

    for (let index = 0; index < 2; index += 1) {
      await expect(
        new PostHogConversationsClient(config).createTicket(ticketInput),
      ).rejects.toMatchObject({
        name: "PostHogConversationsError",
        status: 503,
        message: "PostHog Support Tickets are disabled for this project",
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not expose upstream response bodies in HTTP errors", async () => {
    const upstreamBody = "support message and contact details";
    const response = new Response(upstreamBody, { status: 502 });
    const responseBody = response.body;
    if (!responseBody) {
      throw new Error("Expected an upstream response body");
    }
    const cancel = vi.spyOn(responseBody, "cancel");
    fetchMock.mockResolvedValueOnce(response);

    const client = new PostHogConversationsClient(config);
    const error = await client
      .createTicket(ticketInput)
      .catch((caughtError: unknown) => caughtError);

    expect(error).toBeInstanceOf(PostHogConversationsError);
    expect(error).toMatchObject({
      status: 502,
      message: "PostHog conversations config request failed with status 502",
    });
    expect(error).toHaveProperty("message", expect.not.stringContaining(upstreamBody));
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("reports failed response-body cancellation without replacing the HTTP error", async () => {
    const cancellationError = new Error("body cancellation failed");
    const response = new Response("upstream body", { status: 502 });
    const responseBody = response.body;
    if (!responseBody) {
      throw new Error("Expected an upstream response body");
    }
    vi.spyOn(responseBody, "cancel").mockRejectedValue(cancellationError);
    fetchMock.mockResolvedValueOnce(response);

    await expect(
      new PostHogConversationsClient(config).createTicket(ticketInput),
    ).rejects.toMatchObject({
      status: 502,
      message: "PostHog conversations config request failed with status 502",
    });
    await Promise.resolve();
    expect(mockCaptureException).toHaveBeenCalledWith(cancellationError);
  });

  it("handles HTTP errors without response bodies", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 502 }));

    await expect(
      new PostHogConversationsClient(config).createTicket(ticketInput),
    ).rejects.toMatchObject({
      status: 502,
      message: "PostHog conversations config request failed with status 502",
    });
  });

  it("reports ticket creation failures with their status", async () => {
    fetchMock
      .mockResolvedValueOnce(configResponse("conversation-token"))
      .mockResolvedValueOnce(new Response("  invalid message  ", { status: 422 }));

    const client = new PostHogConversationsClient(config);

    await expect(client.createTicket(ticketInput)).rejects.toMatchObject({
      status: 422,
      message: "PostHog ticket creation request failed with status 422",
    });
    expect(mockSupportTicketOperationsInc).toHaveBeenCalledWith({
      outcome: "failure",
      status_class: "4xx",
    });
    expect(mockSupportTicketDurationObserve).toHaveBeenCalledWith(
      { outcome: "failure" },
      expect.any(Number),
    );
  });

  it("rejects malformed configuration and ticket payloads", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ conversations: { enabled: true, token: "" } }));
    await expect(
      new PostHogConversationsClient(config).createTicket(ticketInput),
    ).rejects.toMatchObject({
      name: "PostHogConversationsError",
      status: 200,
      message: "PostHog conversations config response was invalid",
    });
    expect(mockSupportTicketOperationsInc).toHaveBeenCalledWith({
      outcome: "failure",
      status_class: "2xx",
    });

    fetchMock.mockReset();
    mockSupportTicketOperationsInc.mockReset();
    fetchMock
      .mockResolvedValueOnce(configResponse("conversation-token"))
      .mockResolvedValueOnce(jsonResponse({ ticket_id: " " }));
    await expect(
      new PostHogConversationsClient(config).createTicket(ticketInput),
    ).rejects.toMatchObject({
      name: "PostHogConversationsError",
      status: 200,
      message: "PostHog ticket creation response was invalid",
    });
    expect(mockSupportTicketOperationsInc).toHaveBeenCalledWith({
      outcome: "failure",
      status_class: "2xx",
    });
  });

  it("normalizes invalid JSON responses without exposing the response body", async () => {
    const upstreamBody = "<html>proxy error details</html>";
    fetchMock.mockResolvedValueOnce(new Response(upstreamBody, { status: 200 }));

    const error = await new PostHogConversationsClient(config)
      .createTicket(ticketInput)
      .catch((caughtError: unknown) => caughtError);
    expect(error).toMatchObject({
      name: "PostHogConversationsError",
      status: 200,
      message: "PostHog conversations config response was invalid",
    });
    expect(error).toHaveProperty("message", expect.not.stringContaining(upstreamBody));
    expect(mockSupportTicketOperationsInc).toHaveBeenCalledWith({
      outcome: "failure",
      status_class: "2xx",
    });
  });

  it("preserves non-JSON response body failures", async () => {
    const bodyError = new Error("response body unavailable");
    const response = new Response(null, { status: 200 });
    vi.spyOn(response, "json").mockRejectedValue(bodyError);
    fetchMock.mockResolvedValueOnce(response);

    await expect(new PostHogConversationsClient(config).createTicket(ticketInput)).rejects.toBe(
      bodyError,
    );
    expect(mockSupportTicketOperationsInc).toHaveBeenCalledWith({
      outcome: "failure",
      status_class: "unknown",
    });
  });

  it("converts timeout failures into service errors for config and ticket requests", async () => {
    const configTimeoutController = new AbortController();
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(configTimeoutController.signal);
    fetchMock.mockImplementationOnce((_input, init) => {
      expect(init?.signal).toBe(configTimeoutController.signal);
      configTimeoutController.abort();
      return Promise.reject(configTimeoutController.signal.reason);
    });

    await expect(
      new PostHogConversationsClient(config).createTicket(ticketInput),
    ).rejects.toMatchObject({
      name: "PostHogConversationsError",
      status: 504,
      message: "PostHog conversations config request timed out after 15000ms",
    });

    const ticketTimeoutController = new AbortController();
    timeoutSpy.mockReturnValue(ticketTimeoutController.signal);
    fetchMock.mockReset();
    fetchMock
      .mockResolvedValueOnce(configResponse("conversation-token"))
      .mockImplementationOnce((_input, init) => {
        expect(init?.signal).toBe(ticketTimeoutController.signal);
        ticketTimeoutController.abort();
        return Promise.reject(ticketTimeoutController.signal.reason);
      });

    await expect(
      new PostHogConversationsClient(config).createTicket(ticketInput),
    ).rejects.toMatchObject({
      name: "PostHogConversationsError",
      status: 504,
      message: "PostHog ticket creation request timed out after 15000ms",
    });
    expect(timeoutSpy).toHaveBeenCalledWith(15_000);
  });

  it("converts a stalled response body into a timeout error", async () => {
    const configTimeoutController = new AbortController();
    const ticketTimeoutController = new AbortController();
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValueOnce(configTimeoutController.signal)
      .mockReturnValueOnce(ticketTimeoutController.signal);
    let resolveJsonStarted!: () => void;
    const jsonStarted = new Promise<void>((resolve) => {
      resolveJsonStarted = resolve;
    });
    const response = new Response(null, { status: 200 });
    vi.spyOn(response, "json").mockImplementation(() => {
      resolveJsonStarted();
      return new Promise<unknown>(() => {});
    });
    fetchMock.mockResolvedValueOnce(configResponse("conversation-token"));
    fetchMock.mockResolvedValueOnce(response);

    const pendingTicket = new PostHogConversationsClient(config).createTicket(ticketInput);
    await jsonStarted;
    ticketTimeoutController.abort();

    await expect(pendingTicket).rejects.toMatchObject({
      name: "PostHogConversationsError",
      status: 504,
      message: "PostHog ticket creation request timed out after 15000ms",
    });
    expect(timeoutSpy).toHaveBeenCalledWith(15_000);
  });

  it("rejects a response body when its timeout signal is already aborted", async () => {
    const configTimeoutController = new AbortController();
    const ticketTimeoutController = new AbortController();
    ticketTimeoutController.abort();
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValueOnce(configTimeoutController.signal)
      .mockReturnValueOnce(ticketTimeoutController.signal);
    const response = ticketResponse();
    const jsonSpy = vi.spyOn(response, "json");
    fetchMock.mockResolvedValueOnce(configResponse("conversation-token"));
    fetchMock.mockResolvedValueOnce(response);

    await expect(
      new PostHogConversationsClient(config).createTicket(ticketInput),
    ).rejects.toMatchObject({
      name: "PostHogConversationsError",
      status: 504,
      message: "PostHog ticket creation request timed out after 15000ms",
    });
    expect(jsonSpy).toHaveBeenCalledTimes(1);
    expect(timeoutSpy).toHaveBeenCalledWith(15_000);
  });

  it("removes response body timeout listeners after parsing completes", async () => {
    const configTimeoutController = new AbortController();
    const ticketTimeoutController = new AbortController();
    const configRemoveListener = vi.spyOn(configTimeoutController.signal, "removeEventListener");
    const ticketRemoveListener = vi.spyOn(ticketTimeoutController.signal, "removeEventListener");
    vi.spyOn(AbortSignal, "timeout")
      .mockReturnValueOnce(configTimeoutController.signal)
      .mockReturnValueOnce(ticketTimeoutController.signal);
    fetchMock
      .mockResolvedValueOnce(configResponse("conversation-token"))
      .mockResolvedValueOnce(ticketResponse());

    await expect(new PostHogConversationsClient(config).createTicket(ticketInput)).resolves.toEqual(
      { ticketId: "ticket-1" },
    );
    expect(configRemoveListener).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(ticketRemoveListener).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("preserves non-timeout fetch failures", async () => {
    const networkError = new Error("network unavailable");
    fetchMock.mockRejectedValueOnce(networkError);

    await expect(new PostHogConversationsClient(config).createTicket(ticketInput)).rejects.toBe(
      networkError,
    );
    expect(mockSupportTicketOperationsInc).toHaveBeenCalledWith({
      outcome: "failure",
      status_class: "unknown",
    });
  });
});

describe("getPostHogConversationsClient", () => {
  it("returns the process-wide client instance", () => {
    const client = getPostHogConversationsClient();
    expect(client).toBeInstanceOf(PostHogConversationsClient);
    expect(client).toBe(getPostHogConversationsClient());
  });
});
