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
