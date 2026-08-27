import { type Context, context } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  AiContextSpanProcessor,
  registerAiTelemetry,
  withAiGenerationContext,
} from "./ai-observability.ts";

const aiTelemetryMocks = vi.hoisted(() => ({
  registerTelemetry: vi.fn(),
  OpenTelemetry: vi.fn(
    class {
      constructor() {
        return {};
      }
    },
  ),
}));

vi.mock("ai", () => ({
  registerTelemetry: aiTelemetryMocks.registerTelemetry,
}));

vi.mock("@ai-sdk/otel", () => ({
  OpenTelemetry: aiTelemetryMocks.OpenTelemetry,
}));

describe("AI observability context", () => {
  const contextManager = new AsyncLocalStorageContextManager();

  beforeAll(() => {
    context.setGlobalContextManager(contextManager.enable());
  });

  afterAll(() => {
    contextManager.disable();
    context.disable();
  });

  it("registers the AI SDK telemetry integration only once", () => {
    registerAiTelemetry();
    registerAiTelemetry();

    expect(aiTelemetryMocks.OpenTelemetry).toHaveBeenCalledOnce();
    expect(aiTelemetryMocks.registerTelemetry).toHaveBeenCalledOnce();
  });

  it("adds the current user ID as a standard OpenTelemetry span attribute", async () => {
    const span = { setAttribute: vi.fn() };
    const processor = new AiContextSpanProcessor();

    await withAiGenerationContext({ userId: "user-123" }, async () => {
      await Promise.resolve();
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

  it("does not add a user attribute for an empty user ID", async () => {
    const span = { setAttribute: vi.fn() };
    const processor = new AiContextSpanProcessor();

    await withAiGenerationContext({ userId: "" }, async () => {
      await Promise.resolve();
      processor.onStart(span, context.active());
    });

    expect(span.setAttribute).not.toHaveBeenCalled();
  });

  it("does not add a user attribute when the active context contains an empty user ID", () => {
    const span = { setAttribute: vi.fn() };
    const processor = new AiContextSpanProcessor();
    const emptyUserContext: Context = {
      getValue: () => "",
      setValue: () => context.active(),
      deleteValue: () => context.active(),
    };

    processor.onStart(span, emptyUserContext);

    expect(span.setAttribute).not.toHaveBeenCalled();
  });

  it("supports processor shutdown and flush", async () => {
    const processor = new AiContextSpanProcessor();

    await expect(processor.shutdown()).resolves.toBeUndefined();
    await expect(processor.forceFlush()).resolves.toBeUndefined();
  });
});
