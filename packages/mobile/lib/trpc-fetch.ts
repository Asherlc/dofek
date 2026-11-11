import { captureException, captureTelemetrySessionGuard, logger } from "./telemetry";

const BODY_PREVIEW_LIMIT = 240;

function getResponseContentType(response: Response): string | null {
  return response.headers.get("content-type")?.toLowerCase() ?? null;
}

function isJsonResponse(response: Response): boolean {
  const contentType = getResponseContentType(response);
  return contentType?.includes("json") ?? false;
}

function buildContentTypeLabel(response: Response): string {
  const contentType = getResponseContentType(response);
  return contentType ? `content-type ${contentType}` : "content-type absent";
}

function getTrpcPath(
  input: Parameters<typeof fetch>[0],
  isTelemetrySessionCurrent: () => boolean,
): string {
  const rawUrl =
    typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
  const pathPrefix = "/api/trpc/";

  try {
    const url = new URL(rawUrl, "https://dofek.local");
    const pathIndex = url.pathname.indexOf(pathPrefix);
    return pathIndex >= 0 ? url.pathname.slice(pathIndex + pathPrefix.length) : url.pathname;
  } catch (error: unknown) {
    captureException(error, {
      source: "trpc-request-url-parse",
      ...(isTelemetrySessionCurrent() ? {} : { retiredLifetime: true }),
    });
    return rawUrl;
  }
}

function buildStatusLabel(response: Response): string {
  return response.statusText
    ? `${response.status} ${response.statusText}`
    : String(response.status);
}

async function readBodyPreview(
  response: Response,
  isTelemetrySessionCurrent: () => boolean,
): Promise<string> {
  try {
    return (await response.clone().text()).slice(0, BODY_PREVIEW_LIMIT);
  } catch (error: unknown) {
    captureException(error, {
      source: "trpc-response-body-preview",
      ...(isTelemetrySessionCurrent() ? {} : { retiredLifetime: true }),
    });
    return "body preview unavailable";
  }
}

async function parseJsonBody(
  response: Response,
  input: Parameters<typeof fetch>[0],
  isTelemetrySessionCurrent: () => boolean,
): Promise<unknown> {
  const bodyText = await response.text();
  if (bodyText.trim().length === 0) {
    throw new Error(
      `The server returned an empty response for ${getTrpcPath(input, isTelemetrySessionCurrent)}: ${buildStatusLabel(response)}, ${buildContentTypeLabel(response)}`,
    );
  }

  try {
    return JSON.parse(bodyText);
  } catch (error) {
    const diagnosticError = new Error(
      `The server returned an invalid response for ${getTrpcPath(input, isTelemetrySessionCurrent)}: ${buildStatusLabel(response)}, ${buildContentTypeLabel(response)}`,
      { cause: error },
    );
    captureException(diagnosticError, isTelemetrySessionCurrent() ? {} : { retiredLifetime: true });
    throw diagnosticError;
  }
}

function withJsonBodyDiagnostics(
  response: Response,
  input: Parameters<typeof fetch>[0],
  isTelemetrySessionCurrent: () => boolean,
): Response {
  response.json = () => parseJsonBody(response, input, isTelemetrySessionCurrent);
  return response;
}

export function createTrpcFetch(fetchImpl: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const batchId = new Headers(init?.headers).get("x-dofek-upload-id");
    const isTelemetrySessionCurrent = captureTelemetrySessionGuard();
    const startedAt = Date.now();
    const response = await fetchImpl(input, init);
    if (batchId && isTelemetrySessionCurrent()) {
      logger.info("whoop-ble", "upload_http_response", {
        event: "upload_http_response",
        batchId,
        httpStatus: response.status,
        elapsedMs: Date.now() - startedAt,
      });
    }
    if (isJsonResponse(response)) {
      return withJsonBodyDiagnostics(response, input, isTelemetrySessionCurrent);
    }

    const bodyPreview = await readBodyPreview(response, isTelemetrySessionCurrent);
    throw new Error(
      `Non-JSON tRPC response from ${getTrpcPath(input, isTelemetrySessionCurrent)}: ${buildStatusLabel(response)}, ${buildContentTypeLabel(response)}, ${bodyPreview}`,
    );
  };
}
