import { OpenTelemetry } from "@ai-sdk/otel";
import { type Context, context, createContextKey } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { registerTelemetry } from "ai";

const AI_USER_ID_CONTEXT_KEY = createContextKey("dofek.ai.user_id");
let aiTelemetryRegistered = false;

type SpanAttributeTarget = Pick<Span, "setAttribute">;

export interface AiGenerationContext {
  userId?: string;
}

/** Registers the AI SDK's provider-neutral OpenTelemetry integration once. */
export function registerAiTelemetry(): void {
  if (aiTelemetryRegistered) {
    return;
  }

  registerTelemetry(new OpenTelemetry());
  aiTelemetryRegistered = true;
}

/** Runs an AI operation with generic request context available to OTel processors. */
export function withAiGenerationContext<T>(
  generationContext: AiGenerationContext,
  operation: () => Promise<T>,
): Promise<T> {
  const nextContext = generationContext.userId
    ? context.active().setValue(AI_USER_ID_CONTEXT_KEY, generationContext.userId)
    : context.active().deleteValue(AI_USER_ID_CONTEXT_KEY);

  return context.with(nextContext, operation);
}

/** Returns the generic user identity attached to an AI generation context. */
export function getAiGenerationUserId(parentContext: Context): string | undefined {
  const userId = parentContext.getValue(AI_USER_ID_CONTEXT_KEY);
  return typeof userId === "string" && userId.length > 0 ? userId : undefined;
}

/** Adds standard user context to spans created during an AI operation. */
export class AiContextSpanProcessor implements SpanProcessor {
  onStart(span: SpanAttributeTarget, parentContext: Context): void {
    const userId = getAiGenerationUserId(parentContext);
    if (userId) {
      span.setAttribute("user.id", userId);
    }
  }

  onEnd(_span: ReadableSpan): void {}

  async shutdown(): Promise<void> {}

  async forceFlush(): Promise<void> {}
}
