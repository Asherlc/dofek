import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  PostHogConversationsClient,
  type PostHogConversationsConfig,
  PostHogConversationsError,
} from "./posthog-conversations.ts";

const config: PostHogConversationsConfig = {
  apiKey: "project-token",
  host: "https://us.i.posthog.com",
};

const configUrl = `${config.host}/array/${config.apiKey}/config`;
const messageUrl = `${config.host}/api/conversations/v1/widget/message`;
const mswServer = setupServer();

beforeAll(() => mswServer.listen({ onUnhandledRequest: "error" }));
afterEach(() => mswServer.resetHandlers());
afterAll(() => mswServer.close());

describe("PostHogConversationsClient", () => {
  it("loads the conversation token and creates a ticket with the widget payload", async () => {
    let configCalls = 0;
    let received: { token: string | null; body: unknown } | null = null;

    mswServer.use(
      http.get(configUrl, () => {
        configCalls += 1;
        return HttpResponse.json({ conversations: { enabled: true, token: "conversation-token" } });
      }),
      http.post(messageUrl, async ({ request }) => {
        received = {
          token: request.headers.get("X-Conversations-Token"),
          body: await request.json(),
        };
        return HttpResponse.json({
          ticket_id: "ticket-1",
          message_id: "message-1",
          ticket_status: "new",
          created_at: "2026-08-01T12:00:00.000Z",
          unread_count: 0,
        });
      }),
    );

    const client = new PostHogConversationsClient(config);
    const ticket = await client.createTicket({
      message: "Cannot sync Garmin",
      contactEmail: "user@example.com",
      contactName: "Asher",
      distinctId: "user-1",
      widgetSessionId: "widget-session-1",
    });

    expect(ticket).toEqual({ ticketId: "ticket-1" });
    expect(configCalls).toBe(1);
    expect(received).toEqual({
      token: "conversation-token",
      body: {
        message: "Cannot sync Garmin",
        traits: { name: "Asher", email: "user@example.com" },
        ticket_id: null,
        widget_session_id: "widget-session-1",
        distinct_id: "user-1",
      },
    });
  });

  it("reuses a cached conversation token across ticket creations", async () => {
    let configCalls = 0;
    mswServer.use(
      http.get(configUrl, () => {
        configCalls += 1;
        return HttpResponse.json({ conversations: { enabled: true, token: "conversation-token" } });
      }),
      http.post(messageUrl, () =>
        HttpResponse.json({
          ticket_id: "ticket-1",
          message_id: "message-1",
          ticket_status: "new",
          created_at: "2026-08-01T12:00:00.000Z",
          unread_count: 0,
        }),
      ),
    );

    const client = new PostHogConversationsClient(config);
    const ticketInput = {
      message: "Help",
      contactEmail: "user@example.com",
      contactName: "Asher",
      distinctId: "user-1",
      widgetSessionId: "widget-session-1",
    };
    await client.createTicket(ticketInput);
    await client.createTicket({ ...ticketInput, widgetSessionId: "widget-session-2" });

    expect(configCalls).toBe(1);
  });

  it("refreshes the cached token after an authentication failure", async () => {
    let configCalls = 0;
    let messageCalls = 0;
    const receivedTokens: string[] = [];

    mswServer.use(
      http.get(configUrl, () => {
        configCalls += 1;
        return HttpResponse.json({
          conversations: { enabled: true, token: `conversation-token-${configCalls}` },
        });
      }),
      http.post(messageUrl, ({ request }) => {
        messageCalls += 1;
        receivedTokens.push(request.headers.get("X-Conversations-Token") ?? "missing");
        if (messageCalls === 1) {
          return HttpResponse.json({ detail: "expired" }, { status: 401 });
        }
        return HttpResponse.json({
          ticket_id: "ticket-refreshed",
          message_id: "message-refreshed",
          ticket_status: "new",
          created_at: "2026-08-01T12:00:00.000Z",
          unread_count: 0,
        });
      }),
    );

    const client = new PostHogConversationsClient(config);
    const ticketInput = {
      message: "Help",
      contactEmail: "user@example.com",
      contactName: "Asher",
      distinctId: "user-1",
      widgetSessionId: "widget-session-1",
    };

    await expect(client.createTicket(ticketInput)).rejects.toMatchObject({ status: 401 });
    await expect(
      client.createTicket({ ...ticketInput, widgetSessionId: "widget-session-2" }),
    ).resolves.toEqual({
      ticketId: "ticket-refreshed",
    });

    expect(configCalls).toBe(2);
    expect(receivedTokens).toEqual(["conversation-token-1", "conversation-token-2"]);
  });

  it("throws when conversations are disabled in the project config", async () => {
    mswServer.use(
      http.get(configUrl, () =>
        HttpResponse.json({ conversations: { enabled: false, token: "conversation-token" } }),
      ),
    );

    const client = new PostHogConversationsClient(config);

    await expect(
      client.createTicket({
        message: "Help",
        contactEmail: "user@example.com",
        contactName: "Asher",
        distinctId: "user-1",
        widgetSessionId: "widget-session-1",
      }),
    ).rejects.toBeInstanceOf(PostHogConversationsError);
  });

  it("throws PostHogConversationsError when ticket creation fails", async () => {
    mswServer.use(
      http.get(configUrl, () =>
        HttpResponse.json({ conversations: { enabled: true, token: "conversation-token" } }),
      ),
      http.post(messageUrl, () => HttpResponse.json({ detail: "nope" }, { status: 422 })),
    );

    const client = new PostHogConversationsClient(config);

    await expect(
      client.createTicket({
        message: "Help",
        contactEmail: "user@example.com",
        contactName: "Asher",
        distinctId: "user-1",
        widgetSessionId: "widget-session-1",
      }),
    ).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining('{"detail":"nope"}'),
    });
  });

  it("turns a request timeout into a PostHogConversationsError", async () => {
    const timeoutController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    mswServer.use(
      http.get(configUrl, () => {
        timeoutController.abort();
        return HttpResponse.json({ conversations: { enabled: true, token: "conversation-token" } });
      }),
    );

    try {
      const client = new PostHogConversationsClient(config);
      await expect(
        client.createTicket({
          message: "Help",
          contactEmail: "user@example.com",
          contactName: "Asher",
          distinctId: "user-1",
          widgetSessionId: "widget-session-1",
        }),
      ).rejects.toMatchObject({
        status: 504,
        message: expect.stringContaining("request timed out"),
      });
    } finally {
      timeoutSpy.mockRestore();
    }
  });
});
