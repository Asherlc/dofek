import {
  type CallToolResult,
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import { captureException } from "../../lib/error-reporting.ts";
import { createProviderRateLimitFetch } from "../../lib/provider-rate-limit-fetch.ts";
import { ProviderAccessDeniedError, ProviderAuthorizationFailedError } from "../auth-errors.ts";
import { TRAILFORKS_MCP_RESOURCE } from "./auth.ts";

const LIST_MY_ACTIVITIES_TOOL = "list_my_activities";
const TRAILFORKS_MCP_ENDPOINT = new URL(TRAILFORKS_MCP_RESOURCE);

export const TRAILFORKS_MCP_ACCESS_DENIED_MESSAGE =
  "Trailforks denied access. Confirm an active Pro/Outside+ subscription and that activities:read was granted, then reconnect.";

export class TrailforksMcpToolError extends Error {
  constructor() {
    super("Trailforks could not complete the activity list.");
    this.name = "TrailforksMcpToolError";
  }
}

export interface ConnectTrailforksActivityClientOptions {
  accessToken: string;
  fetchFn?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCallToolResult(value: unknown): value is CallToolResult {
  return isRecord(value) && Array.isArray(value.content);
}

function discardResponseBody(response: Response): void {
  void response.body?.cancel().catch(() => undefined);
}

/**
 * SDK-backed Trailforks MCP account client: open once, call only `list_my_activities`
 * with opaque caller JSON arguments, then close. Result encoding stays opaque until
 * live Trailforks payloads are observed.
 */
export class TrailforksActivityClient {
  readonly #client: Client;

  constructor(client: Client) {
    this.#client = client;
  }

  static async connect(
    options: ConnectTrailforksActivityClientOptions,
  ): Promise<TrailforksActivityClient> {
    const rateLimitFetch = createProviderRateLimitFetch("trailforks", options.fetchFn);
    const sdkClient = new Client(
      { name: "dofek-trailforks", version: "0.1.0" },
      { capabilities: {} },
    );
    const fetchWithAuthBoundary: typeof globalThis.fetch = async (input, init) => {
      const runSignal = options.signal;
      const initSignal = init?.signal;
      const signal =
        runSignal && initSignal != null
          ? AbortSignal.any([runSignal, initSignal])
          : (runSignal ?? initSignal);
      const response = await rateLimitFetch(input, { ...init, signal });
      // Map known auth HTTP statuses before the SDK can surface remote bodies.
      if (response.status === 401) {
        discardResponseBody(response);
        throw new ProviderAuthorizationFailedError("Trailforks");
      }
      if (response.status === 403) {
        discardResponseBody(response);
        throw new ProviderAccessDeniedError(TRAILFORKS_MCP_ACCESS_DENIED_MESSAGE);
      }
      return response;
    };
    const transport = new StreamableHTTPClientTransport(TRAILFORKS_MCP_ENDPOINT, {
      fetch: fetchWithAuthBoundary,
      requestInit: {
        headers: { Authorization: `Bearer ${options.accessToken}` },
      },
    });

    try {
      await sdkClient.connect(transport, { signal: options.signal });
      return new TrailforksActivityClient(sdkClient);
    } catch (error) {
      try {
        await sdkClient.close();
      } catch (closeError) {
        captureException(new TrailforksMcpToolError(), {
          tags: { provider: "trailforks", mcpPhase: "close_after_connect_failure" },
          extra: {
            errorName: closeError instanceof Error ? closeError.name : typeof closeError,
          },
        });
      }
      throw error;
    }
  }

  /**
   * Invokes only `list_my_activities` with the caller's JSON arguments.
   * Returns the SDK `CallToolResult` unchanged, or a provider-safe tool failure
   * when MCP reports `isError` (raw tool content is not exposed).
   */
  async listMyActivities(args: Record<string, unknown>): Promise<CallToolResult> {
    const result = await this.#client.callTool({
      name: LIST_MY_ACTIVITIES_TOOL,
      arguments: args,
    });
    if (!isCallToolResult(result)) {
      throw new TrailforksMcpToolError();
    }
    if (result.isError === true) {
      throw new TrailforksMcpToolError();
    }
    return result;
  }

  async close(): Promise<void> {
    await this.#client.close();
  }
}
