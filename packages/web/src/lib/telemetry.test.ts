// @vitest-environment jsdom
import { SpanStatusCode } from "@opentelemetry/api";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const mockRecordException = vi.fn();
  const mockSetStatus = vi.fn();
  const mockSetAttribute = vi.fn();
  const mockEnd = vi.fn();
  const mockStartSpan = vi.fn(() => ({
    recordException: mockRecordException,
    setStatus: mockSetStatus,
    setAttribute: mockSetAttribute,
    end: mockEnd,
  }));
  const mockGetActiveSpan = vi.fn();

  return {
    mockRecordException,
    mockSetStatus,
    mockSetAttribute,
    mockEnd,
    mockStartSpan,
    mockGetActiveSpan,
  };
});

vi.mock("@opentelemetry/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@opentelemetry/api")>();
  return {
    ...original,
    trace: {
      getActiveSpan: mocks.mockGetActiveSpan,
      getTracer: () => ({
        startSpan: mocks.mockStartSpan,
      }),
    },
  };
});

describe("web telemetry", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
    vi.stubGlobal("__COMMIT_HASH__", "abc1234");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("records exceptions on active spans", async () => {
    const activeSpan = {
      recordException: mocks.mockRecordException,
      setStatus: mocks.mockSetStatus,
      setAttribute: mocks.mockSetAttribute,
      end: mocks.mockEnd,
    };
    mocks.mockGetActiveSpan.mockReturnValue(activeSpan);

    const mod = await import("./telemetry.ts");
    mod.captureException(new Error("boom"), { route: "dashboard" });

    expect(mocks.mockRecordException).toHaveBeenCalledWith(expect.any(Error));
    expect(mocks.mockSetStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: "boom",
    });
    expect(mocks.mockSetAttribute).toHaveBeenCalledWith("app.release", "abc1234");
    expect(mocks.mockSetAttribute).toHaveBeenCalledWith("error.route", "dashboard");
  });

  it("creates a span when there is no active span", async () => {
    mocks.mockGetActiveSpan.mockReturnValue(undefined);

    const mod = await import("./telemetry.ts");
    mod.captureException(new Error("no-active-span"));

    expect(mocks.mockStartSpan).toHaveBeenCalledWith("web.error.capture");
    expect(mocks.mockEnd).toHaveBeenCalled();
  });

  it("normalizes non-error exceptions", async () => {
    mocks.mockGetActiveSpan.mockReturnValue(undefined);

    const mod = await import("./telemetry.ts");
    mod.captureException("plain-string-error");

    expect(mocks.mockSetStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: "plain-string-error",
    });
  });
});
