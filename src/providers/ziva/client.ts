import { isDeepStrictEqual } from "node:util";
import {
  ProviderRateLimitError,
  ProviderRequestTimeoutError,
  ProviderServiceUnavailableError,
} from "@dofek/provider-http/rate-limit";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StreamableHTTPClientTransport,
  StreamableHTTPError,
} from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { type CallToolResult, ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { captureException } from "../../lib/error-reporting.ts";
import { createProviderRateLimitFetch } from "../../lib/provider-rate-limit-fetch.ts";
import { parseZivaMealPayload, type ZivaMealPayload } from "./schemas.ts";

const ZIVA_MCP_ENDPOINT = new URL("https://connect.ziva.fit/mcp");
const ZIVA_MEAL_TOOL = "get_meals_for_date";
const MCP_OPERATION_TIMEOUT_MS = 30_000;
const MAX_TOOL_LIST_PAGES = 20;

export class ZivaMcpAuthenticationError extends Error {
  constructor() {
    super("Ziva authorization failed. Reconnect Ziva and try again.");
    this.name = "ZivaMcpAuthenticationError";
  }
}

export class ZivaMcpToolError extends Error {
  constructor(message = "Ziva could not complete the diary read.") {
    super(message);
    this.name = "ZivaMcpToolError";
  }
}

export class ZivaMcpMalformedResponseError extends Error {
  constructor() {
    super("Ziva returned an invalid diary response.");
    this.name = "ZivaMcpMalformedResponseError";
  }
}

export class ZivaMcpTimeoutError extends Error {
  readonly timeoutMs = MCP_OPERATION_TIMEOUT_MS;

  constructor() {
    super(`Ziva diary request timed out after ${MCP_OPERATION_TIMEOUT_MS}ms.`);
    this.name = "ZivaMcpTimeoutError";
  }
}

export class ZivaMcpTransportError extends Error {
  constructor() {
    super("Ziva MCP communication failed.");
    this.name = "ZivaMcpTransportError";
  }
}

export interface ConnectZivaMcpClientOptions {
  accessToken: string;
  fetchFn?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

export interface ZivaMcpRequestOptions {
  signal?: AbortSignal;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function schemaAllowsString(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.type === "string") return true;
  if (Array.isArray(value.type) && value.type.includes("string")) return true;
  return [value.anyOf, value.oneOf].some(
    (variants) => Array.isArray(variants) && variants.some(schemaAllowsString),
  );
}

function isCompatibleMealTool(tool: {
  name: string;
  inputSchema: { properties?: Record<string, object> };
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    openWorldHint?: boolean;
  };
}): boolean {
  const properties = tool.inputSchema.properties;
  return (
    tool.name === ZIVA_MEAL_TOOL &&
    schemaAllowsString(properties?.start_date) &&
    schemaAllowsString(properties?.end_date) &&
    tool.annotations?.readOnlyHint === true &&
    tool.annotations.destructiveHint === false &&
    tool.annotations.openWorldHint === false
  );
}

function callerCancellation(signal: AbortSignal | undefined): unknown {
  if (!signal?.aborted) return undefined;
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

function isZodValidationError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "ZodError" || error.name === "$ZodError") &&
    isRecord(error) &&
    Array.isArray(error.issues)
  );
}

function isCallToolResult(value: unknown): value is CallToolResult {
  return isRecord(value) && Array.isArray(value.content);
}

function throwClassifiedRequestError(
  error: unknown,
  signal: AbortSignal | undefined,
  phase: "connect" | "list_tools" | "call_tool",
): never {
  const cancellation = callerCancellation(signal);
  if (cancellation !== undefined) throw cancellation;

  if (
    error instanceof ProviderRateLimitError ||
    error instanceof ProviderRequestTimeoutError ||
    error instanceof ProviderServiceUnavailableError
  ) {
    throw error;
  }
  if (
    error instanceof ZivaMcpAuthenticationError ||
    error instanceof ZivaMcpMalformedResponseError ||
    error instanceof ZivaMcpTimeoutError ||
    error instanceof ZivaMcpToolError ||
    error instanceof ZivaMcpTransportError
  ) {
    throw error;
  }
  if (error instanceof StreamableHTTPError) {
    if (error.code === 401) {
      throw new ZivaMcpAuthenticationError();
    }
    const sanitizedError = new ZivaMcpTransportError();
    captureException(sanitizedError, {
      tags: { provider: "ziva", mcpPhase: phase },
      extra: { statusCode: error.code },
    });
    throw sanitizedError;
  }
  if (error instanceof McpError) {
    if (error.code === ErrorCode.RequestTimeout) {
      throw new ZivaMcpTimeoutError();
    }
    const sanitizedError = new ZivaMcpTransportError();
    captureException(sanitizedError, {
      tags: { provider: "ziva", mcpPhase: phase },
      extra: { mcpErrorCode: error.code },
    });
    throw sanitizedError;
  }
  if (isZodValidationError(error)) {
    throw new ZivaMcpMalformedResponseError();
  }

  const sanitizedError = new ZivaMcpTransportError();
  captureException(sanitizedError, {
    tags: { provider: "ziva", mcpPhase: phase },
    extra: { errorName: error instanceof Error ? error.name : typeof error },
  });
  throw sanitizedError;
}

function parsePayload(value: unknown, expectedDate: string): ZivaMealPayload {
  try {
    return parseZivaMealPayload(value, { expectedDate });
  } catch {
    throw new ZivaMcpMalformedResponseError();
  }
}

function parseTextPayload(text: string, expectedDate: string): ZivaMealPayload {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ZivaMcpMalformedResponseError();
  }
  return parsePayload(value, expectedDate);
}

export class ZivaMcpClient {
  readonly #client: Client;

  constructor(client: Client) {
    this.#client = client;
  }

  static async connect(options: ConnectZivaMcpClientOptions): Promise<ZivaMcpClient> {
    if (options.accessToken.trim().length === 0) {
      throw new ZivaMcpAuthenticationError();
    }

    const rateLimitFetch = createProviderRateLimitFetch("ziva", options.fetchFn);
    const transport = new StreamableHTTPClientTransport(ZIVA_MCP_ENDPOINT, {
      fetch: rateLimitFetch,
      requestInit: {
        headers: { Authorization: `Bearer ${options.accessToken}` },
      },
    });
    const sdkClient = new Client({ name: "dofek-ziva", version: "0.1.0" }, { capabilities: {} });
    const client = new ZivaMcpClient(sdkClient);

    try {
      await sdkClient.connect(transport, {
        timeout: MCP_OPERATION_TIMEOUT_MS,
        signal: options.signal,
      });
      await client.#verifyMealTool(options.signal);
      return client;
    } catch (error) {
      try {
        await sdkClient.close();
      } catch (closeError) {
        captureException(new ZivaMcpTransportError(), {
          tags: { provider: "ziva", mcpPhase: "close_after_connect_failure" },
          extra: {
            errorName: closeError instanceof Error ? closeError.name : typeof closeError,
          },
        });
      }
      throwClassifiedRequestError(error, options.signal, "connect");
    }
  }

  async #verifyMealTool(signal: AbortSignal | undefined): Promise<void> {
    const tools = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;

    try {
      for (let pageNumber = 0; pageNumber < MAX_TOOL_LIST_PAGES; pageNumber += 1) {
        const page = await this.#client.listTools(cursor ? { cursor } : undefined, {
          timeout: MCP_OPERATION_TIMEOUT_MS,
          signal,
        });
        tools.push(...page.tools);
        if (!page.nextCursor) break;
        if (seenCursors.has(page.nextCursor)) {
          throw new ZivaMcpToolError("Ziva returned an invalid tool-list cursor sequence.");
        }
        seenCursors.add(page.nextCursor);
        cursor = page.nextCursor;

        if (pageNumber === MAX_TOOL_LIST_PAGES - 1) {
          throw new ZivaMcpToolError("Ziva returned too many tool-list pages.");
        }
      }
    } catch (error) {
      throwClassifiedRequestError(error, signal, "list_tools");
    }

    const mealTools = tools.filter((tool) => tool.name === ZIVA_MEAL_TOOL);
    const mealTool = mealTools[0];
    if (mealTools.length !== 1 || !mealTool || !isCompatibleMealTool(mealTool)) {
      throw new ZivaMcpToolError("Ziva's read-only meal tool is unavailable or incompatible.");
    }
  }

  async getMealsForDate(
    date: string,
    options: ZivaMcpRequestOptions = {},
  ): Promise<ZivaMealPayload> {
    let result: unknown;
    try {
      result = await this.#client.callTool(
        { name: ZIVA_MEAL_TOOL, arguments: { start_date: date } },
        undefined,
        { timeout: MCP_OPERATION_TIMEOUT_MS, signal: options.signal },
      );
    } catch (error) {
      throwClassifiedRequestError(error, options.signal, "call_tool");
    }

    if (!isCallToolResult(result)) {
      throw new ZivaMcpMalformedResponseError();
    }
    if (result.isError === true) {
      throw new ZivaMcpToolError();
    }

    const textBlocks = result.content.filter(
      (content): content is Extract<CallToolResult["content"][number], { type: "text" }> =>
        content.type === "text",
    );
    if (textBlocks.length > 1) {
      throw new ZivaMcpMalformedResponseError();
    }

    const structuredPayload =
      result.structuredContent === undefined
        ? undefined
        : parsePayload(result.structuredContent, date);
    const textPayload =
      textBlocks[0] === undefined ? undefined : parseTextPayload(textBlocks[0].text, date);

    if (structuredPayload && textPayload) {
      if (!isDeepStrictEqual(structuredPayload, textPayload)) {
        throw new ZivaMcpMalformedResponseError();
      }
      return structuredPayload;
    }
    if (structuredPayload) return structuredPayload;
    if (textPayload) return textPayload;
    throw new ZivaMcpMalformedResponseError();
  }

  async close(): Promise<void> {
    await this.#client.close();
  }
}
