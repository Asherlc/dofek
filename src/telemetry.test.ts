import { SpanStatusCode } from "@opentelemetry/api";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  mockRecordException,
  mockSetStatus,
  mockSetAttribute,
  mockAddEvent,
  mockEnd,
  mockStartSpan,
  mockGetActiveSpan,
  mockNotify,
  mockBugsnagStart,
} = vi.hoisted(() => {
  const recordExceptionMock = vi.fn();
  const setStatusMock = vi.fn();
  const setAttributeMock = vi.fn();
  const addEventMock = vi.fn();
  const endMock = vi.fn();
  const startSpanMock = vi.fn(() => ({
    recordException: recordExceptionMock,
    setStatus: setStatusMock,
    setAttribute: setAttributeMock,
    addEvent: addEventMock,
    end: endMock,
  }));
  const getActiveSpanMock = vi.fn();
  const notifyMock = vi.fn();
  const bugsnagStartMock = vi.fn(() => ({ notify: notifyMock }));
  return {
    mockRecordException: recordExceptionMock,
    mockSetStatus: setStatusMock,
    mockSetAttribute: setAttributeMock,
    mockAddEvent: addEventMock,
    mockEnd: endMock,
    mockStartSpan: startSpanMock,
    mockGetActiveSpan: getActiveSpanMock,
    mockNotify: notifyMock,
    mockBugsnagStart: bugsnagStartMock,
  };
});

vi.mock("@opentelemetry/api", async (importOriginal) => {
  const original = await importOriginal<typeof import("@opentelemetry/api")>();
  return {
    ...original,
    trace: {
      getActiveSpan: mockGetActiveSpan,
      getTracer: () => ({
        startSpan: mockStartSpan,
      }),
    },
  };
});

vi.mock("@bugsnag/js", () => ({
  default: {
    start: mockBugsnagStart,
  },
}));

describe("node telemetry", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    delete process.env.BUGSNAG_API_KEY;
    delete process.env.ERROR_REPORTER;
  });

  it("records exceptions on OTLP spans by default", async () => {
    const { captureException } = await import("./telemetry.ts");
    const activeSpan = {
      recordException: mockRecordException,
      setStatus: mockSetStatus,
      setAttribute: mockSetAttribute,
      addEvent: mockAddEvent,
      end: mockEnd,
    };
    mockGetActiveSpan.mockReturnValue(activeSpan);

    captureException(new Error("boom"), { context: "unit-test" });

    expect(mockRecordException).toHaveBeenCalled();
    expect(mockSetStatus).toHaveBeenCalledWith({
      code: SpanStatusCode.ERROR,
      message: "boom",
    });
    expect(mockSetAttribute).toHaveBeenCalledWith("error.context", "unit-test");
    expect(mockBugsnagStart).not.toHaveBeenCalled();
  });

  it("creates a span when no active span exists", async () => {
    const { captureException } = await import("./telemetry.ts");
    mockGetActiveSpan.mockReturnValue(undefined);

    captureException(new Error("no-active-span"));

    expect(mockStartSpan).toHaveBeenCalledWith("error.capture");
    expect(mockEnd).toHaveBeenCalled();
  });

  it("switches to Bugsnag when configured", async () => {
    process.env.ERROR_REPORTER = "bugsnag";
    process.env.BUGSNAG_API_KEY = "bugsnag-test-key";

    const { captureException } = await import("./telemetry.ts");
    captureException(new Error("send-to-bugsnag"), { source: "test-suite" });

    expect(mockBugsnagStart).toHaveBeenCalledWith({ apiKey: "bugsnag-test-key" });
    expect(mockNotify).toHaveBeenCalledWith(expect.any(Error), expect.any(Function));
    expect(mockStartSpan).not.toHaveBeenCalled();
    expect(mockRecordException).not.toHaveBeenCalled();
  });

  it("records messages as span events", async () => {
    const { captureMessage } = await import("./telemetry.ts");
    mockGetActiveSpan.mockReturnValue(undefined);

    captureMessage("stale view", {
      level: "warning",
      tags: { userId: "user-1" },
      extra: { reason: "test" },
    });

    expect(mockStartSpan).toHaveBeenCalledWith("error.message");
    expect(mockAddEvent).toHaveBeenCalledWith("error.message", {
      "message.text": "stale view",
      "message.level": "warning",
      "tag.userId": "user-1",
      "extra.reason": "test",
    });
  });
});
