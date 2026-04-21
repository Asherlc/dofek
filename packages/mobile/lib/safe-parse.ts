import type { ZodType, ZodTypeDef } from "zod";
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

/**
 * Parse an array of rows with a Zod schema, reporting failures to telemetry
 * instead of silently swallowing them.
 *
 * Returns `{ data, error }` so components can show error UI rather than
 * an empty list when the server response doesn't match the expected shape.
 */
export function safeParseRows<T>(
  schema: ZodType<T, ZodTypeDef, unknown>,
  rows: unknown,
  context: string,
): SafeParseResult<T> {
  const result = schema.array().safeParse(rows ?? []);
  if (result.success) {
    return { data: result.data, error: null };
  }
  const parseError = new Error(`${context}: Zod parse failed: ${result.error.message}`);
  captureException(parseError, { context, zodError: result.error.format() });
  return { data: [], error: parseError };
}
