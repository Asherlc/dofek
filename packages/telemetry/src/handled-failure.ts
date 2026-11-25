type HandledFailure =
  | "offline"
  | "cancelled"
  | "invalid_credentials"
  | "connection_lost"
  | "bluetooth_timeout"
  | "http_5xx";

/** Typed HTTP response failure carrying a status from an actual Response. */
export class HttpResponseError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "HttpResponseError";
    this.status = status;
  }
}

/** True for HTTP statuses 500–599 inclusive. */
export function isHttpServerErrorStatus(status: number): boolean {
  return status >= 500 && status <= 599;
}

/** True when JSON body decoding failed on an already observed HTTP 5xx response. */
export function isHttpServerErrorJsonParseFailure(error: unknown, status: number): boolean {
  return error instanceof SyntaxError && isHttpServerErrorStatus(status);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Matches the installed tRPC client `isTRPCErrorResponse` / TRPCClientError envelope. */
function isTrpcErrorEnvelope(value: unknown): boolean {
  return (
    isRecord(value) &&
    isRecord(value.error) &&
    typeof value.error.code === "number" &&
    typeof value.error.message === "string"
  );
}

function isTrpcErrorBody(value: unknown): boolean {
  if (isTrpcErrorEnvelope(value)) return true;
  return Array.isArray(value) && value.length > 0 && value.every(isTrpcErrorEnvelope);
}

/**
 * For tRPC HTTP transports: pass non-5xx and structured tRPC 5xx envelopes;
 * throw HttpResponseError for raw HTTP 5xx (HTML, generic JSON, decode failures).
 */
export async function guardTrpcHttpResponse(response: Response): Promise<Response> {
  if (!isHttpServerErrorStatus(response.status)) {
    return response;
  }

  const fallbackMessage = `The server returned HTTP ${response.status}`;
  if (!(response.headers.get("content-type")?.toLowerCase().includes("json") ?? false)) {
    throw new HttpResponseError(fallbackMessage, response.status);
  }

  let body: unknown;
  try {
    body = await response.clone().json();
  } catch {
    throw new HttpResponseError(fallbackMessage, response.status);
  }

  if (isTrpcErrorBody(body)) {
    return response;
  }
  throw new HttpResponseError(fallbackMessage, response.status);
}

/** Classify handled outcomes only; unknown failures remain reportable. */
export function classifyHandledFailure(error: unknown, source?: string): HandledFailure | null {
  const visited = new Set<unknown>();
  let current = error;
  while (typeof current === "object" && current !== null && !visited.has(current)) {
    visited.add(current);
    if (current instanceof SyntaxError || (current instanceof Error && current.name === "ZodError"))
      return null;
    let kind: HandledFailure | null = null;
    if (
      "data" in current &&
      typeof current.data === "object" &&
      current.data !== null &&
      "handledFailure" in current.data &&
      current.data.handledFailure === "invalid_credentials"
    ) {
      kind ??= "invalid_credentials";
    }
    if (current instanceof Error) {
      if (current instanceof HttpResponseError && isHttpServerErrorStatus(current.status)) {
        kind ??= "http_5xx";
      }
      if (
        source === "auth-state-restore" &&
        current.message === "fetch failed: The network connection was lost."
      ) {
        kind ??= "connection_lost";
      }
      if (
        (source === "whoop-ble-init-sync" || source === "whoop-ble-foreground-sync") &&
        "code" in current &&
        current.code === "TIMEOUT"
      ) {
        kind ??= "bluetooth_timeout";
      }
      if (
        current.name === "AbortError" ||
        /^(?:fetch failed:\s*cancel(?:led|ed)|The operation was aborted\.)$/i.test(current.message)
      ) {
        kind ??= "cancelled";
      }
      if (
        /^fetch failed:\s*(?:UnexpectedException:\s*)?The Internet connection appears to be offline\.(?: \(at [^)]+\))?$/i.test(
          current.message,
        )
      ) {
        kind ??= "offline";
      }
      if (current.cause === undefined) return kind;
      current = current.cause;
    } else {
      return kind;
    }
  }
  return null;
}
