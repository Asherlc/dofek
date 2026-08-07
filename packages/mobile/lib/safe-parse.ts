import type { ZodType } from "zod";
import { captureException } from "./telemetry";

interface ParseSuccess<T> {
  data: T[];
  error: null;
}

interface ParseFailure {
  data: [];
  error: Error;
}

type SafeParseResult<T> = ParseSuccess<T> | ParseFailure;

interface ParseDataSuccess<T> {
  data: T;
  error: null;
}

interface ParseDataFailure {
  data: undefined;
  error: Error;
}

/**
 * Parse an array of rows with a Zod schema, reporting failures to Sentry
 * instead of silently swallowing them.
 *
 * Returns `{ data, error }` so components can show error UI rather than
 * an empty list when the server response doesn't match the expected shape.
 */
export function safeParseRows<T>(
  schema: ZodType<T>,
  rows: unknown,
  context: string,
): SafeParseResult<T> {
  const result = schema.array().safeParse(rows);
  if (result.success) {
    return { data: result.data, error: null };
  }
  const parseError = new Error(`${context}: Zod parse failed: ${result.error.message}`);
  captureException(parseError, { context, zodError: result.error.format() });
  return { data: [], error: parseError };
}

/** Parse one runtime-boundary value and report schema drift to Sentry. */
export function safeParseData<T>(
  schema: ZodType<T>,
  value: unknown,
  context: string,
): ParseDataSuccess<T> | ParseDataFailure {
  const result = schema.safeParse(value);
  if (result.success) {
    return { data: result.data, error: null };
  }
  const parseError = new Error(`${context}: Zod parse failed: ${result.error.message}`);
  captureException(parseError, { context, zodError: result.error.format() });
  return { data: undefined, error: parseError };
}
