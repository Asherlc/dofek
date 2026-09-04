export type ZeppConnectionType = "zepp" | "zepp-workout";

export interface HealthEnvelopeEvent<T> {
  eventId: string;
  createdAt: string;
  payload: T;
}

export interface HealthEnvelopeV1<T> {
  version: 1;
  batchId: string;
  source: {
    connectionType: ZeppConnectionType;
    installId: string;
  };
  events: HealthEnvelopeEvent<T>[];
}

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationErrorDetails {
  formErrors?: unknown;
  fieldErrors?: unknown;
}

export interface RejectedHealthEvent {
  eventId: string;
  issues: ValidationIssue[];
}

export interface HealthUploadResponse {
  acceptedEventIds: string[];
  rejected: RejectedHealthEvent[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonBlank(value: string): boolean {
  return value.trim().length > 0;
}

export function createHealthEnvelope<T>(
  input: Omit<HealthEnvelopeV1<T>, "version">,
): HealthEnvelopeV1<T> {
  if (
    !nonBlank(input.batchId) ||
    !nonBlank(input.source.installId) ||
    input.events.some((event) => !nonBlank(event.eventId) || !nonBlank(event.createdAt))
  ) {
    throw new Error("Health envelope identifiers must not be blank.");
  }

  return { version: 1, ...input };
}

function isConnectionType(value: unknown): value is ZeppConnectionType {
  return value === "zepp" || value === "zepp-workout";
}

export function parseHealthEnvelope(value: unknown): HealthEnvelopeV1<Record<string, unknown>> {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    typeof value.batchId !== "string" ||
    !nonBlank(value.batchId) ||
    !isRecord(value.source) ||
    !isConnectionType(value.source.connectionType) ||
    typeof value.source.installId !== "string" ||
    !nonBlank(value.source.installId) ||
    !Array.isArray(value.events) ||
    value.events.length === 0
  ) {
    throw new Error("Health envelope is invalid.");
  }

  const events: HealthEnvelopeEvent<Record<string, unknown>>[] = [];
  for (const event of value.events) {
    if (
      !isRecord(event) ||
      typeof event.eventId !== "string" ||
      !nonBlank(event.eventId) ||
      typeof event.createdAt !== "string" ||
      !nonBlank(event.createdAt) ||
      !isRecord(event.payload)
    ) {
      throw new Error("Health envelope is invalid.");
    }
    events.push({ eventId: event.eventId, createdAt: event.createdAt, payload: event.payload });
  }

  return {
    version: 1,
    batchId: value.batchId,
    source: {
      connectionType: value.source.connectionType,
      installId: value.source.installId,
    },
    events,
  };
}

function parseValidationIssue(value: unknown): ValidationIssue {
  if (!isRecord(value) || typeof value.path !== "string" || typeof value.message !== "string") {
    throw new Error("Health upload response is invalid.");
  }
  return { path: value.path, message: value.message };
}

export function parseHealthUploadResponse(value: unknown): HealthUploadResponse {
  if (
    !isRecord(value) ||
    value.status !== "ok" ||
    !Array.isArray(value.acceptedEventIds) ||
    !value.acceptedEventIds.every((eventId) => typeof eventId === "string" && nonBlank(eventId)) ||
    !Array.isArray(value.rejected)
  ) {
    throw new Error("Health upload response is invalid.");
  }

  const rejected = value.rejected.map((event) => {
    if (
      !isRecord(event) ||
      typeof event.eventId !== "string" ||
      !nonBlank(event.eventId) ||
      !Array.isArray(event.issues)
    ) {
      throw new Error("Health upload response is invalid.");
    }
    return { eventId: event.eventId, issues: event.issues.map(parseValidationIssue) };
  });

  return { acceptedEventIds: value.acceptedEventIds, rejected };
}

function messages(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (message): message is string => typeof message === "string" && message.trim().length > 0,
  );
}

export function validationIssuesFromDetails(details: unknown): ValidationIssue[] {
  if (!isRecord(details)) {
    return [];
  }

  const issues = messages(details.formErrors).map((message) => ({ path: "$", message }));
  if (!isRecord(details.fieldErrors)) {
    return issues;
  }

  for (const path of Object.keys(details.fieldErrors).sort()) {
    for (const message of messages(details.fieldErrors[path])) {
      issues.push({ path, message });
    }
  }
  return issues;
}
