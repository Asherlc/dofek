import { POSTHOG_API_KEY, POSTHOG_HOST } from "dofek/lib/posthog-config";
import { z } from "zod";

const conversationConfigSchema = z.object({
  conversations: z.object({
    enabled: z.boolean(),
    token: z.string().trim().min(1),
  }),
});

const createTicketResponseSchema = z.object({
  ticket_id: z.string().trim().min(1),
});

const CONVERSATIONS_CONFIG_TTL_MS = 5 * 60 * 1000;
const CONVERSATIONS_MESSAGE_PATH = "/api/conversations/v1/widget/message";

export interface PostHogConversationsConfig {
  apiKey: string;
  host: string;
}

export interface PostHogSupportTicketInput {
  message: string;
  contactEmail: string;
  contactName: string;
  distinctId: string;
  widgetSessionId: string;
}

export interface CreatedPostHogTicket {
  ticketId: string;
}

export class PostHogConversationsError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "PostHogConversationsError";
    this.status = status;
  }
}

/**
 * Minimal PostHog Support Tickets client. The conversations token is public
 * project configuration, fetched and cached for the same five-minute window
 * used by PostHog's remote configuration endpoint.
 */
export class PostHogConversationsClient {
  #conversationToken: string | null = null;
  #conversationTokenExpiresAt = 0;
  readonly #config: PostHogConversationsConfig;

  constructor(config: PostHogConversationsConfig) {
    this.#config = {
      ...config,
      host: config.host.replace(/\/+$/, ""),
    };
  }

  async #getConversationToken(): Promise<string> {
    if (this.#conversationToken && Date.now() < this.#conversationTokenExpiresAt) {
      return this.#conversationToken;
    }

    const response = await fetch(
      `${this.#config.host}/array/${encodeURIComponent(this.#config.apiKey)}/config`,
      { headers: { Accept: "application/json" } },
    );

    if (!response.ok) {
      throw new PostHogConversationsError(
        `PostHog conversations config request failed with status ${response.status}`,
        response.status,
      );
    }

    const config = conversationConfigSchema.parse(await response.json());
    if (!config.conversations.enabled) {
      throw new PostHogConversationsError(
        "PostHog Support Tickets are disabled for this project",
        503,
      );
    }

    this.#conversationToken = config.conversations.token;
    this.#conversationTokenExpiresAt = Date.now() + CONVERSATIONS_CONFIG_TTL_MS;
    return this.#conversationToken;
  }

  async createTicket(input: PostHogSupportTicketInput): Promise<CreatedPostHogTicket> {
    const conversationToken = await this.#getConversationToken();
    const response = await fetch(`${this.#config.host}${CONVERSATIONS_MESSAGE_PATH}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Conversations-Token": conversationToken,
      },
      body: JSON.stringify({
        message: input.message.trim(),
        traits: {
          name: input.contactName,
          email: input.contactEmail,
        },
        ticket_id: null,
        widget_session_id: input.widgetSessionId,
        distinct_id: input.distinctId,
      }),
    });

    if (!response.ok) {
      throw new PostHogConversationsError(
        `PostHog ticket creation failed with status ${response.status}`,
        response.status,
      );
    }

    const ticket = createTicketResponseSchema.parse(await response.json());
    return { ticketId: ticket.ticket_id };
  }
}

let cachedClient: PostHogConversationsClient | null = null;

/** Lazily construct a process-wide PostHog Support Tickets client. */
export function getPostHogConversationsClient(): PostHogConversationsClient {
  if (!cachedClient) {
    cachedClient = new PostHogConversationsClient({
      apiKey: POSTHOG_API_KEY,
      host: POSTHOG_HOST,
    });
  }
  return cachedClient;
}
