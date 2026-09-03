import { context, SpanKind } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const posthogMocks = vi.hoisted(() => ({
  delegate: {
    onStart: vi.fn(),
    onEnd: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
    forceFlush: vi.fn().mockResolvedValue(undefined),
  } satisfies SpanProcessor,
  PostHogSpanProcessor: vi.fn(),
}));

posthogMocks.PostHogSpanProcessor.mockImplementation(function postHogSpanProcessorConstructor() {
  return posthogMocks.delegate;
});

vi.mock("@posthog/ai/otel", () => ({
  PostHogSpanProcessor: posthogMocks.PostHogSpanProcessor,
}));

import { withAiGenerationContext } from "./ai-observability.ts";
import { PostHogAiSpanProcessor } from "./posthog-ai-observability.ts";

function makeSpan(): Span {
  return {
    ...makeReadableSpan("gen_ai.generate", {}),
    setAttribute: vi.fn(),
    setAttributes: vi.fn(),
    addEvent: vi.fn(),
    addLink: vi.fn(),
    addLinks: vi.fn(),
    setStatus: vi.fn(),
    updateName: vi.fn(),
    end: vi.fn(),
    isRecording: vi.fn(() => true),
    recordException: vi.fn(),
  } satisfies Span;
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

describe("PostHog AI observability adapter", () => {
  const contextManager = new AsyncLocalStorageContextManager();

  beforeAll(() => {
    context.setGlobalContextManager(contextManager.enable());
  });

  afterAll(() => {
    contextManager.disable();
    context.disable();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps the generic user identity onto the live span at the adapter boundary", async () => {
    const processor = new PostHogAiSpanProcessor({
      projectToken: "phc_test",
    });
    const span = makeSpan();

    await withAiGenerationContext({ userId: "user-123" }, async () => {
      processor.onStart(span, context.active());
    });

    expect(posthogMocks.PostHogSpanProcessor).toHaveBeenCalledWith({
      projectToken: "phc_test",
    });
    expect(span.setAttribute).toHaveBeenCalledWith("posthog_distinct_id", "user-123");
    expect(posthogMocks.delegate.onStart).toHaveBeenCalledWith(span, expect.anything());
  });

  it("does not add a provider identity without a generic user identity", () => {
    const processor = new PostHogAiSpanProcessor({
      projectToken: "phc_test",
    });
    const span = makeSpan();

    processor.onStart(span, context.active());

    expect(span.setAttribute).not.toHaveBeenCalled();
    expect(posthogMocks.delegate.onStart).toHaveBeenCalledWith(span, expect.anything());
  });

  it("does not add a provider identity for an empty user identity", async () => {
    const processor = new PostHogAiSpanProcessor({
      projectToken: "phc_test",
    });
    const span = makeSpan();

    await withAiGenerationContext({ userId: "" }, async () => {
      processor.onStart(span, context.active());
    });

    expect(span.setAttribute).not.toHaveBeenCalled();
    expect(posthogMocks.delegate.onStart).toHaveBeenCalledWith(span, expect.anything());
  });

  it("forwards the original ended span unchanged", () => {
    const processor = new PostHogAiSpanProcessor({
      projectToken: "phc_test",
    });
    const span = makeReadableSpan("gen_ai.generate", {
      "gen_ai.request.model": "test-model",
    });

    processor.onEnd(span);

    expect(posthogMocks.delegate.onEnd).toHaveBeenCalledWith(span);
    expect(posthogMocks.delegate.onEnd.mock.calls[0]?.[0]).toBe(span);
  });

  it("forwards lifecycle operations to the PostHog processor", async () => {
    const processor = new PostHogAiSpanProcessor({
      projectToken: "phc_test",
    });
    await expect(processor.shutdown()).resolves.toBeUndefined();
    await expect(processor.forceFlush()).resolves.toBeUndefined();

    expect(posthogMocks.delegate.shutdown).toHaveBeenCalledOnce();
    expect(posthogMocks.delegate.forceFlush).toHaveBeenCalledOnce();
  });
});
