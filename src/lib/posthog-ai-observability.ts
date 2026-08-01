import type { Context } from "@opentelemetry/api";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { PostHogSpanProcessor, type PostHogSpanProcessorOptions } from "@posthog/ai/otel";

/** Adds PostHog-specific AI identity at the provider export boundary. */
export class PostHogAiSpanProcessor implements SpanProcessor {
  #delegate: PostHogSpanProcessor;

  constructor(options: PostHogSpanProcessorOptions) {
    this.#delegate = new PostHogSpanProcessor(options);
  }

  onStart(_span: Span, _parentContext: Context): void {}

  onEnd(span: ReadableSpan): void {
    this.#delegate.onEnd(addPostHogIdentity(span));
  }

  shutdown(): Promise<void> {
    return this.#delegate.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.#delegate.forceFlush();
  }
}

function addPostHogIdentity(span: ReadableSpan): ReadableSpan {
  const userId = span.attributes["user.id"];
  if (typeof userId !== "string" || userId.length === 0) {
    return span;
  }

  return {
    ...span,
    attributes: {
      ...span.attributes,
      posthog_distinct_id: userId,
    },
  };
}
