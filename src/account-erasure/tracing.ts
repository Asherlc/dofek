import { context } from "@opentelemetry/api";
import { suppressTracing } from "@opentelemetry/core";

export function withAccountErasureTracingSuppressed<T>(operation: () => T): T {
  return context.with(suppressTracing(context.active()), operation);
}
