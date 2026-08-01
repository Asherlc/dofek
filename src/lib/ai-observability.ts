import { type Context, context, createContextKey } from "@opentelemetry/api";
import type { SpanProcessor } from "@opentelemetry/sdk-trace-node";

const AI_USER_ID_CONTEXT_KEY = createContextKey("dofek.ai.user_id");

type Span = Parameters<SpanProcessor["onStart"]>[0];
type ReadableSpan = Parameters<SpanProcessor["onEnd"]>[0];
type SpanAttributeTarget = Pick<Span, "setAttribute">;

export interface AiGenerationContext {
  userId?: string;
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

/** Adds standard user context to spans created during an AI operation. */
export class AiContextSpanProcessor implements SpanProcessor {
  onStart(span: SpanAttributeTarget, parentContext: Context): void {
    const userId = parentContext.getValue(AI_USER_ID_CONTEXT_KEY);
    if (typeof userId === "string" && userId.length > 0) {
      span.setAttribute("user.id", userId);
    }
  }

  onEnd(_span: ReadableSpan): void {}

  async shutdown(): Promise<void> {}

  async forceFlush(): Promise<void> {}
}
