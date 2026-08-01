import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { PostHogSpanProcessor, type PostHogSpanProcessorOptions } from "@posthog/ai/otel";
import { getAiGenerationUserId } from "./ai-observability.ts";

/** Adds PostHog-specific AI identity at the provider export boundary. */
export class PostHogAiSpanProcessor implements SpanProcessor {
  #delegate: PostHogSpanProcessor;

  constructor(options: PostHogSpanProcessorOptions) {
    this.#delegate = new PostHogSpanProcessor(options);
  }

  onStart(span: Span, parentContext: Context): void {
    const userId = getAiGenerationUserId(parentContext);
    if (userId) {
      span.setAttribute("posthog_distinct_id", userId);
    }

    this.#delegate.onStart(span, parentContext);
  }

  onEnd(span: ReadableSpan): void {
    this.#delegate.onEnd(span);
  }

  shutdown(): Promise<void> {
    return this.#delegate.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.#delegate.forceFlush();
  }
}
