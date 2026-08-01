import { OpenTelemetry } from "@ai-sdk/otel";
import { type Context, context, createContextKey } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { registerTelemetry } from "ai";

const AI_USER_ID_CONTEXT_KEY = createContextKey("dofek.ai.user_id");
const AI_SPAN_PREFIXES = ["gen_ai.", "llm.", "ai.", "traceloop."] as const;
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

/** Forwards only completed AI spans to an observability provider processor. */
export class AiOnlySpanProcessor implements SpanProcessor {
  #delegate: SpanProcessor;

  constructor(delegate: SpanProcessor) {
    this.#delegate = delegate;
  }

  onStart(_span: Span, _parentContext: Context): void {}

  onEnd(span: ReadableSpan): void {
    if (isAiSpan(span)) {
      this.#delegate.onEnd(span);
    }
  }

  shutdown(): Promise<void> {
    return this.#delegate.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.#delegate.forceFlush();
  }
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

function isAiSpan(span: ReadableSpan): boolean {
  if (AI_SPAN_PREFIXES.some((prefix) => span.name.startsWith(prefix))) {
    return true;
  }

  return Object.keys(span.attributes).some((key) =>
    AI_SPAN_PREFIXES.some((prefix) => key.startsWith(prefix)),
  );
}
