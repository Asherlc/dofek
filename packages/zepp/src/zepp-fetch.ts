import { validationIssuesFromDetails } from "./health-contract.ts";
import { STORAGE_KEYS } from "./storage-keys.ts";

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

interface UploadFailureStorage {
  removeItem(key: string): unknown;
  setItem(key: string, value: string): void;
}

export function handleDofekUploadFailure(
  storage: UploadFailureStorage,
  summary: ZeppFetchSummary,
  fallbackMessage: string,
): Error {
  if (summary.status === 401) {
    storage.removeItem(STORAGE_KEYS.DOFEK_API_TOKEN);
    storage.setItem(
      STORAGE_KEYS.DOFEK_CONNECTION_STATUS,
      JSON.stringify({ state: "error", reason: "Dofek connection expired. Connect again." }),
    );
  }
  return new Error(summary.errorMessage ?? fallbackMessage);
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
    const error = body.error.trim();
    const issues = validationIssuesFromDetails(body.details);
    return issues.length === 0
      ? error
      : `${error}: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`;
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
