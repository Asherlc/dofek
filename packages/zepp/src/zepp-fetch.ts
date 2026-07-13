export interface ZeppFetchResponse {
  status?: number;
  statusCode?: number;
  body?: unknown;
}

export interface ZeppFetchSummary {
  body: unknown;
  errorMessage: string | null;
  ok: boolean;
  status: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseBody(body: unknown): unknown {
  if (typeof body !== "string") {
    return body;
  }

  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function getStatus(response: ZeppFetchResponse): number | null {
  if (typeof response.status === "number") {
    return response.status;
  }
  if (typeof response.statusCode === "number") {
    return response.statusCode;
  }
  return null;
}

function getBodyErrorMessage(body: unknown): string | null {
  if (isRecord(body) && typeof body.error === "string" && body.error.trim()) {
    return body.error.trim();
  }
  if (isRecord(body) && typeof body.message === "string" && body.message.trim()) {
    return body.message.trim();
  }
  if (typeof body === "string" && body.trim()) {
    return body.trim();
  }
  return null;
}

export function summarizeZeppFetchResponse(response: ZeppFetchResponse): ZeppFetchSummary {
  const status = getStatus(response);
  const body = parseBody(response.body);
  const bodyError = getBodyErrorMessage(body);
  const failedStatus = status !== null && (status < 200 || status >= 300);
  const errorMessage = failedStatus ? (bodyError ?? `HTTP ${status}`) : bodyError;

  return {
    body,
    errorMessage,
    ok: errorMessage === null,
    status,
  };
}
