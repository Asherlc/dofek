import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const spans: Array<{
    options: Record<string, unknown>;
    end: ReturnType<typeof vi.fn>;
    setAttributes: ReturnType<typeof vi.fn>;
    setStatus: ReturnType<typeof vi.fn>;
  }> = [];
  const mockAppLoaded = vi.fn();
  const mockLoggerInfo = vi.fn();

  return {
    spans,
    mockAppLoaded,
    mockLoggerInfo,
    mockStartInactiveSpan: vi.fn((options: Record<string, unknown>) => {
      const span = {
        options,
        end: vi.fn(),
        setAttributes: vi.fn(),
        setStatus: vi.fn(),
        setAttribute: vi.fn(),
        isRecording: vi.fn().mockReturnValue(true),
        spanContext: vi.fn().mockReturnValue({
          traceId: "trace-id",
          spanId: `span-${spans.length}`,
          traceFlags: 1,
        }),
        updateName: vi.fn(),
        addEvent: vi.fn(),
        addLink: vi.fn(),
      };
      spans.push(span);
      return span;
    }),
  };
});

vi.mock("@sentry/react-native", () => ({
  appLoaded: mocks.mockAppLoaded,
  startInactiveSpan: mocks.mockStartInactiveSpan,
}));

vi.mock("expo-updates", () => ({
  channel: "production",
  isEmbeddedLaunch: true,
  launchDuration: 4_800,
  runtimeVersion: "1.2.3",
  updateId: "update-id",
}));

vi.mock("./telemetry", () => ({
  logger: {
    info: mocks.mockLoggerInfo,
  },
}));

describe("startup telemetry", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.spans.length = 0;
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-29T12:00:05.000Z"));
  });

  it("attributes native OTA launch time before JavaScript on one startup trace", async () => {
    const { startStartupTelemetry } = await import("./startup-telemetry");

    startStartupTelemetry();

    const [startup, ota, javascript] = mocks.spans;
    expect(startup?.options).toMatchObject({
      name: "Mobile Startup",
      op: "ui.load",
      forceTransaction: true,
      startTime: new Date("2026-07-29T12:00:00.200Z"),
      attributes: {
        "app.start.expo_launch_duration_ms": 4_800,
        "app.start.expo_embedded_launch": true,
        "app.start.expo_channel": "production",
        "app.start.expo_runtime_version": "1.2.3",
        "app.start.expo_update_id": "update-id",
      },
    });
    expect(ota?.options).toMatchObject({
      name: "OTA launch",
      op: "app.start.ota",
      parentSpan: startup,
      startTime: new Date("2026-07-29T12:00:00.200Z"),
    });
    expect(ota?.end).toHaveBeenCalledWith(new Date("2026-07-29T12:00:05.000Z"));
    expect(javascript?.options).toMatchObject({
      name: "JavaScript bootstrap",
      op: "app.start.javascript",
      parentSpan: startup,
      startTime: new Date("2026-07-29T12:00:05.000Z"),
    });
  });

  it("finishes each startup phase once with duration and outcome", async () => {
    const { finishStartupPhase, startStartupPhase, startStartupTelemetry } = await import(
      "./startup-telemetry"
    );
    startStartupTelemetry();
    vi.advanceTimersByTime(25);

    startStartupPhase("authentication");
    startStartupPhase("authentication");
    vi.advanceTimersByTime(75);
    finishStartupPhase("authentication", "authenticated");
    finishStartupPhase("authentication", "error");

    const authSpans = mocks.spans.filter(
      ({ options }) => options.op === "app.start.authentication",
    );
    expect(authSpans).toHaveLength(1);
    expect(authSpans[0]?.setAttributes).toHaveBeenCalledWith({
      "app.start.duration_ms": 75,
      "app.start.outcome": "authenticated",
    });
    expect(authSpans[0]?.end).toHaveBeenCalledTimes(1);
    expect(mocks.mockLoggerInfo).toHaveBeenCalledWith(
      "app-startup",
      "Startup phase completed: phase=authentication durationMs=75 outcome=authenticated",
      {
        durationMs: 75,
        outcome: "authenticated",
        phase: "authentication",
      },
    );
  });

  it("records a new authentication attempt after a deferred restore", async () => {
    const { finishStartupPhase, startStartupPhase, startStartupTelemetry } = await import(
      "./startup-telemetry"
    );
    startStartupTelemetry();
    startStartupPhase("authentication");
    vi.advanceTimersByTime(20);
    finishStartupPhase("authentication", "deferred");

    startStartupPhase("authentication");
    vi.advanceTimersByTime(30);
    finishStartupPhase("authentication", "authenticated");

    const authSpans = mocks.spans.filter(
      ({ options }) => options.op === "app.start.authentication",
    );
    expect(authSpans).toHaveLength(2);
    expect(authSpans[0]?.setAttributes).toHaveBeenCalledWith({
      "app.start.duration_ms": 20,
      "app.start.outcome": "deferred",
    });
    expect(authSpans[1]?.setAttributes).toHaveBeenCalledWith({
      "app.start.duration_ms": 30,
      "app.start.outcome": "authenticated",
    });
  });

  it("marks the app interactive but waits for deferred services before closing the lifecycle", async () => {
    const { finishStartupPhase, markAppInteractive, startStartupPhase, startStartupTelemetry } =
      await import("./startup-telemetry");
    startStartupTelemetry();
    finishStartupPhase("javascript", "ready");
    startStartupPhase("authentication");
    finishStartupPhase("authentication", "authenticated");
    startStartupPhase("splash-hide");
    markAppInteractive({ serviceBootstrapExpected: true });

    const startup = mocks.spans[0];
    expect(mocks.mockAppLoaded).toHaveBeenCalledTimes(1);
    expect(startup?.end).not.toHaveBeenCalled();

    startStartupPhase("service-bootstrap");
    vi.advanceTimersByTime(40);
    finishStartupPhase("service-bootstrap", "ready");

    expect(startup?.setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({
        "app.start.interactive_duration_ms": 4_800,
        "app.start.lifecycle_outcome": "ready",
      }),
    );
    expect(startup?.end).toHaveBeenCalledTimes(1);
  });

  it("closes unauthenticated startup without waiting for services", async () => {
    const { finishStartupPhase, markAppInteractive, startStartupPhase, startStartupTelemetry } =
      await import("./startup-telemetry");
    startStartupTelemetry();
    finishStartupPhase("javascript", "ready");
    startStartupPhase("authentication");
    finishStartupPhase("authentication", "unauthenticated");
    startStartupPhase("splash-hide");
    markAppInteractive({ serviceBootstrapExpected: false });
    markAppInteractive({ serviceBootstrapExpected: false });

    const startup = mocks.spans[0];
    const serviceSpan = mocks.spans.find(
      ({ options }) => options.op === "app.start.service_bootstrap",
    );
    expect(serviceSpan?.setAttributes).toHaveBeenCalledWith({
      "app.start.duration_ms": 0,
      "app.start.outcome": "skipped",
    });
    expect(mocks.mockAppLoaded).toHaveBeenCalledTimes(1);
    expect(startup?.end).toHaveBeenCalledTimes(1);
  });

  it("records failed phases as errors without preventing trace closure", async () => {
    const { finishStartupPhase, markAppInteractive, startStartupPhase, startStartupTelemetry } =
      await import("./startup-telemetry");
    startStartupTelemetry();
    finishStartupPhase("javascript", "ready");
    startStartupPhase("authentication");
    finishStartupPhase("authentication", "error");
    startStartupPhase("splash-hide");
    markAppInteractive({ serviceBootstrapExpected: false, outcome: "error" });

    const authSpan = mocks.spans.find(({ options }) => options.op === "app.start.authentication");
    expect(authSpan?.setStatus).toHaveBeenCalledWith({
      code: 2,
      message: "error",
    });
    expect(mocks.spans[0]?.setStatus).toHaveBeenCalledWith({
      code: 2,
      message: "error",
    });
    expect(mocks.spans[0]?.end).toHaveBeenCalledTimes(1);
  });
});
