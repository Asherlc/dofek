import { type Context, type ContextManager, context, SpanKind } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  AiContextSpanProcessor,
  AiOnlySpanProcessor,
  withAiGenerationContext,
} from "./ai-observability.ts";

class TestContextManager implements ContextManager {
  #activeContext = context.active();

  active(): Context {
    return this.#activeContext;
  }

  with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
    nextContext: Context,
    operation: F,
    _thisArg?: ThisParameterType<F>,
    ...args: A
  ): ReturnType<F> {
    const previousContext = this.#activeContext;
    this.#activeContext = nextContext;
    try {
      return operation(...args);
    } finally {
      this.#activeContext = previousContext;
    }
  }

  bind<T>(_nextContext: Context, target: T): T {
    return target;
  }

  enable(): this {
    return this;
  }

  disable(): this {
    return this;
  }
}

function makeReadableSpan(name: string, attributes: ReadableSpan["attributes"]): ReadableSpan {
  return {
    name,
    kind: SpanKind.INTERNAL,
    spanContext: () => ({
      traceId: "00000000000000000000000000000000",
      spanId: "0000000000000000",
      traceFlags: 0,
    }),
    startTime: [0, 0],
    endTime: [0, 0],
    status: { code: 0 },
    attributes,
    links: [],
    events: [],
    duration: [0, 0],
    ended: true,
    resource: resourceFromAttributes({}),
    instrumentationScope: { name: "test" },
    droppedAttributesCount: 0,
    droppedEventsCount: 0,
    droppedLinksCount: 0,
  };
}

describe("AI observability context", () => {
  beforeAll(() => {
    context.setGlobalContextManager(new TestContextManager());
  });

  afterAll(() => {
    context.disable();
  });

  it("adds the current user ID as a standard OpenTelemetry span attribute", async () => {
    const span = { setAttribute: vi.fn() };
    const processor = new AiContextSpanProcessor();

    await withAiGenerationContext({ userId: "user-123" }, async () => {
      processor.onStart(span, context.active());
    });

    expect(span.setAttribute).toHaveBeenCalledWith("user.id", "user-123");
  });

  it("does not add a user attribute without a user context", () => {
    const span = { setAttribute: vi.fn() };
    const processor = new AiContextSpanProcessor();

    processor.onStart(span, context.active());

    expect(span.setAttribute).not.toHaveBeenCalled();
  });

  it("supports processor shutdown and flush", async () => {
    const processor = new AiContextSpanProcessor();

    await expect(processor.shutdown()).resolves.toBeUndefined();
    await expect(processor.forceFlush()).resolves.toBeUndefined();
  });

  it("forwards only AI spans to the delegate processor", () => {
    const delegate = {
      onStart: vi.fn(),
      onEnd: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
      forceFlush: vi.fn().mockResolvedValue(undefined),
    } satisfies SpanProcessor;
    const processor = new AiOnlySpanProcessor(delegate);
    const nonAiSpan = makeReadableSpan("http.request", { "http.request.method": "GET" });
    const aiSpan = makeReadableSpan("ai.generateText", {});

    processor.onEnd(nonAiSpan);
    processor.onEnd(aiSpan);

    expect(delegate.onEnd).toHaveBeenCalledOnce();
    expect(delegate.onEnd).toHaveBeenCalledWith(aiSpan);
  });

  it("recognizes AI spans by semantic-convention attributes", () => {
    const delegate = {
      onStart: vi.fn(),
      onEnd: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
      forceFlush: vi.fn().mockResolvedValue(undefined),
    } satisfies SpanProcessor;
    const processor = new AiOnlySpanProcessor(delegate);
    const aiSpan = makeReadableSpan("llm.request", { "gen_ai.request.model": "test-model" });

    processor.onEnd(aiSpan);

    expect(delegate.onEnd).toHaveBeenCalledWith(aiSpan);
  });

  it("forwards lifecycle operations to the delegate", async () => {
    const delegate = {
      onStart: vi.fn(),
      onEnd: vi.fn(),
      shutdown: vi.fn().mockResolvedValue(undefined),
      forceFlush: vi.fn().mockResolvedValue(undefined),
    } satisfies SpanProcessor;
    const processor = new AiOnlySpanProcessor(delegate);

    await processor.forceFlush();
    await processor.shutdown();

    expect(delegate.forceFlush).toHaveBeenCalledOnce();
    expect(delegate.shutdown).toHaveBeenCalledOnce();
  });
});
