import { type Context, type ContextManager, context } from "@opentelemetry/api";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AiContextSpanProcessor, withAiGenerationContext } from "./ai-observability.ts";

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
});
