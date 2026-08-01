import { POSTHOG_API_KEY, POSTHOG_HOST } from "dofek/lib/posthog-config";
import { z } from "zod";
import { supportTicketDuration, supportTicketOperationsTotal } from "./metrics.ts";

const conversationConfigSchema = z.object({
  conversations: z.union([
    z.object({
      enabled: z.literal(true),
      token: z.string().trim().min(1),
    }),
    z.object({
      enabled: z.literal(false),
      token: z.string().trim().optional(),
    }),
    z.literal(false).transform(() => ({ enabled: false as const, token: undefined })),
  ]),
});

const createTicketResponseSchema = z.object({
  ticket_id: z.string().trim().min(1),
});

const CONVERSATIONS_CONFIG_TTL_MS = 5 * 60 * 1000;
const CONVERSATIONS_MESSAGE_PATH = "/api/conversations/v1/widget/message";
const POSTHOG_REQUEST_TIMEOUT_MS = 15_000;

type SupportTicketOutcome = "success" | "failure";

interface FetchedPostHogResponse {
  response: Response;
  timeoutSignal: AbortSignal;
}

function getStatusClass(error: unknown): string {
  if (!(error instanceof PostHogConversationsError)) {
    return "unknown";
  }
  return `${Math.floor(error.status / 100)}xx`;
}

function recordSupportTicketMetrics(
  outcome: SupportTicketOutcome,
  startedAt: number,
  error?: unknown,
): void {
  supportTicketOperationsTotal.inc({
    outcome,
    status_class: outcome === "success" ? "2xx" : getStatusClass(error),
  });
  supportTicketDuration.observe({ outcome }, (performance.now() - startedAt) / 1000);
}

function createTimeoutError(operation: string): PostHogConversationsError {
  return new PostHogConversationsError(
    `PostHog ${operation} request timed out after ${POSTHOG_REQUEST_TIMEOUT_MS}ms`,
    504,
  );
}

async function fetchPostHog(
  url: string,
  init: RequestInit,
  operation: string,
): Promise<FetchedPostHogResponse> {
  const timeoutSignal = AbortSignal.timeout(POSTHOG_REQUEST_TIMEOUT_MS);

  try {
    return {
      response: await fetch(url, { ...init, signal: timeoutSignal }),
      timeoutSignal,
    };
  } catch (error) {
    if (timeoutSignal.aborted) {
      throw createTimeoutError(operation);
    }
    throw error;
  }
}

async function readPostHogJson(
  fetchedResponse: FetchedPostHogResponse,
  operation: string,
): Promise<unknown> {
  let rejectOnTimeout!: () => void;
  const timeout = new Promise<never>((_, reject) => {
    rejectOnTimeout = () => reject(createTimeoutError(operation));
    fetchedResponse.timeoutSignal.addEventListener("abort", rejectOnTimeout);
  });
  if (fetchedResponse.timeoutSignal.aborted) {
    rejectOnTimeout();
  }

  try {
    return await Promise.race([fetchedResponse.response.json(), timeout]);
  } finally {
    fetchedResponse.timeoutSignal.removeEventListener("abort", rejectOnTimeout);
  }
}

async function parsePostHogJson<T>(
  fetchedResponse: FetchedPostHogResponse,
  operation: string,
  schema: z.ZodType<T>,
): Promise<T> {
  const payload = await readPostHogJson(fetchedResponse, operation);
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new PostHogConversationsError(
      `PostHog ${operation} response was invalid`,
      fetchedResponse.response.status,
    );
  }
  return parsed.data;
}

function createHttpError(operation: string, response: Response): PostHogConversationsError {
  return new PostHogConversationsError(
    `PostHog ${operation} request failed with status ${response.status}`,
    response.status,
  );
}

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
  #conversationTokenRequest: Promise<string> | null = null;
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

    if (this.#conversationTokenRequest) {
      return this.#conversationTokenRequest;
    }

    const tokenRequest = this.#loadConversationToken();
    this.#conversationTokenRequest = tokenRequest;
    try {
      return await tokenRequest;
    } finally {
      this.#conversationTokenRequest = null;
    }
  }

  async #loadConversationToken(): Promise<string> {
    const fetchedResponse = await fetchPostHog(
      `${this.#config.host}/array/${encodeURIComponent(this.#config.apiKey)}/config`,
      { headers: { Accept: "application/json" } },
      "conversations config",
    );
    const { response } = fetchedResponse;

    if (!response.ok) {
      throw createHttpError("conversations config", response);
    }

    const config = await parsePostHogJson(
      fetchedResponse,
      "conversations config",
      conversationConfigSchema,
    );
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

  async #createTicketRequest(input: PostHogSupportTicketInput): Promise<CreatedPostHogTicket> {
    const conversationToken = await this.#getConversationToken();
    const fetchedResponse = await fetchPostHog(
      `${this.#config.host}${CONVERSATIONS_MESSAGE_PATH}`,
      {
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
      },
      "ticket creation",
    );
    const { response } = fetchedResponse;

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        this.#conversationToken = null;
        this.#conversationTokenExpiresAt = 0;
      }
      throw createHttpError("ticket creation", response);
    }

    const ticket = await parsePostHogJson(
      fetchedResponse,
      "ticket creation",
      createTicketResponseSchema,
    );
    return { ticketId: ticket.ticket_id };
  }

  async #createTicketWithRetry(input: PostHogSupportTicketInput): Promise<CreatedPostHogTicket> {
    try {
      return await this.#createTicketRequest(input);
    } catch (error) {
      if (
        !(error instanceof PostHogConversationsError) ||
        (error.status !== 401 && error.status !== 403)
      ) {
        throw error;
      }
      return await this.#createTicketRequest(input);
    }
  }

  async createTicket(input: PostHogSupportTicketInput): Promise<CreatedPostHogTicket> {
    const startedAt = performance.now();
    try {
      const ticket = await this.#createTicketWithRetry(input);
      recordSupportTicketMetrics("success", startedAt);
      return ticket;
    } catch (error) {
      recordSupportTicketMetrics("failure", startedAt, error);
      throw error;
    }
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
