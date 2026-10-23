import { captureException } from "../../lib/error-reporting.ts";
import { authErrorCodeSchema } from "../../lib/provider-diagnostics.ts";
import { logger } from "../../logger.ts";
import type { ProviderConnectionError } from "../auth-errors.ts";

const MAX_DIAGNOSTIC_BODY_BYTES = 8192;
const errorFields = [
  "error",
  "errors",
  "code",
  "errorCode",
  "error_description",
  "errorMessage",
  "message",
] as const;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const traceparentPattern = /^00-(?!0{32}-)[0-9a-f]{32}-(?!0{16}-)[0-9a-f]{16}-0[01]$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseContentType(response: Response): string {
  const type = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  switch (type) {
    case "application/json":
    case "application/problem+json":
    case "text/html":
    case "text/plain":
      return type;
    default:
      return "unknown";
  }
}

async function inspectBody(response: Response, contentType: string) {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let body = "";
  try {
    reader = response.clone().body?.getReader();
    if (!reader) return { bodyKind: "empty" };
    const decoder = new TextDecoder();
    let bytes = 0;
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_DIAGNOSTIC_BODY_BYTES) return { bodyKind: "too_large" };
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
  } catch {
    // Stream errors can contain upstream data; retain only a fixed diagnostic error.
    captureException(new Error("Unable to read Garmin connection diagnostic response"), {
      tags: { provider: "garmin", operation: "oauth-connection-diagnostics" },
    });
    return { bodyKind: "unreadable" };
  } finally {
    if (reader) {
      // A cloned stream's cancellation can wait for the untouched original branch.
      void reader.cancel().catch((_error: unknown) => {
        captureException(new Error("Unable to cancel Garmin connection diagnostic reader"), {
          tags: { provider: "garmin", operation: "oauth-connection-diagnostics" },
        });
      });
      reader.releaseLock();
    }
  }
  if (!body.trim()) return { bodyKind: "empty" };
  if (contentType !== "application/json" && contentType !== "application/problem+json") {
    return { bodyKind: contentType === "text/html" ? "html" : "text" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { bodyKind: "invalid_json" };
  }
  if (Array.isArray(parsed)) return { bodyKind: "json_array" };
  if (!isRecord(parsed)) return { bodyKind: "json_scalar" };

  const candidates = [parsed.error, parsed.code, parsed.errorCode];
  if (Array.isArray(parsed.errors)) {
    for (const entry of parsed.errors) {
      if (isRecord(entry)) candidates.push(entry.code);
    }
  }
  const errorCodes = new Set<string>();
  for (const candidate of candidates) {
    const code = authErrorCodeSchema.safeParse(candidate);
    if (code.success) errorCodes.add(code.data);
  }
  return {
    bodyKind: "json_object",
    bodyFields: errorFields.filter((field) => Object.hasOwn(parsed, field)),
    errorCodes: [...errorCodes],
  };
}

export async function reportGarminConnectionHttpFailure(
  response: Response,
  error: ProviderConnectionError,
): Promise<void> {
  const requestIds: Record<string, string> = {};
  for (const header of ["x-request-id", "x-correlation-id", "request-id", "traceparent"]) {
    const value = response.headers.get(header);
    const pattern = header === "traceparent" ? traceparentPattern : uuidPattern;
    if (value && pattern.test(value)) requestIds[header] = value;
  }
  const contentType = responseContentType(response);
  const diagnostic = {
    event: "connection_http_failed",
    providerId: "garmin",
    stage: error.stage,
    statusCode: error.statusCode,
    contentType,
    ...(await inspectBody(response, contentType)),
    requestIds,
  };
  logger.warn(`[garmin-oauth] ${JSON.stringify(diagnostic)}`);
  captureException(error, {
    tags: { provider: "garmin", operation: "oauth-connection", stage: error.stage },
    extra: diagnostic,
    level: "warning",
  });
}
