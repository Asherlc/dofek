import { SpanKind } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { beforeEach, describe, expect, it, vi } from "vitest";

const posthogMocks = vi.hoisted(() => ({
  delegate: {
    onStart: vi.fn(),
    onEnd: vi.fn(),
    shutdown: vi.fn().mockResolvedValue(undefined),
    forceFlush: vi.fn().mockResolvedValue(undefined),
  } satisfies SpanProcessor,
  PostHogSpanProcessor: vi.fn(),
}));

posthogMocks.PostHogSpanProcessor.mockImplementation(() => posthogMocks.delegate);

vi.mock("@posthog/ai/otel", () => ({
  PostHogSpanProcessor: posthogMocks.PostHogSpanProcessor,
}));

import { PostHogAiSpanProcessor } from "./posthog-ai-observability.ts";

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
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps the generic user identity to PostHog at the adapter boundary", () => {
    const processor = new PostHogAiSpanProcessor({
      projectToken: "phc_test",
    });
    const span = makeReadableSpan("gen_ai.generate", {
      "user.id": "user-123",
      "gen_ai.request.model": "test-model",
    });

    processor.onEnd(span);

    expect(posthogMocks.PostHogSpanProcessor).toHaveBeenCalledWith({
      projectToken: "phc_test",
    });
    expect(posthogMocks.delegate.onEnd).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: expect.objectContaining({
          "user.id": "user-123",
          posthog_distinct_id: "user-123",
        }),
      }),
    );
  });

  it("does not add a provider identity without a generic user identity", () => {
    const processor = new PostHogAiSpanProcessor({
      projectToken: "phc_test",
    });
    const span = makeReadableSpan("gen_ai.generate", {
      "gen_ai.request.model": "test-model",
    });

    processor.onEnd(span);

    expect(posthogMocks.delegate.onEnd).toHaveBeenCalledWith(span);
  });

  it("does not add a provider identity for empty or non-string user identities", () => {
    const processor = new PostHogAiSpanProcessor({
      projectToken: "phc_test",
    });
    const emptyUserIdSpan = makeReadableSpan("gen_ai.generate", {
      "user.id": "",
      "gen_ai.request.model": "test-model",
    });
    const nonStringUserIdSpan = makeReadableSpan("gen_ai.generate", {
      "user.id": true,
      "gen_ai.request.model": "test-model",
    });

    processor.onEnd(emptyUserIdSpan);
    processor.onEnd(nonStringUserIdSpan);

    expect(posthogMocks.delegate.onEnd).toHaveBeenNthCalledWith(1, emptyUserIdSpan);
    expect(posthogMocks.delegate.onEnd).toHaveBeenNthCalledWith(2, nonStringUserIdSpan);
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
