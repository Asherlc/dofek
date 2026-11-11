import { AppState, type AppStateStatus } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getDiagnostics } from "../modules/background-refresh";
import { createBackgroundRefreshDiagnostics } from "./background-refresh-diagnostics";
import { captureException, logger } from "./telemetry";

vi.mock("./telemetry", () => ({ captureException: vi.fn(), logger: { info: vi.fn() } }));

const event = {
  eventId: "11111111-1111-4111-8111-111111111111",
  occurredAt: "2026-10-24T10:00:00.000Z",
  nativeSessionId: "33333333-3333-4333-8333-333333333333",
  processId: 42,
  event: "schedule_failed",
  taskId: "44444444-4444-4444-8444-444444444444",
  taskIdentifier: "com.dofek.accelerometer-refresh",
  earliestBeginAt: "2026-10-24T10:15:00.000Z",
  success: false,
  reason: "submit_failed",
  backgroundRefreshStatus: "denied",
  lowPowerModeEnabled: true,
  errorDomain: "BGTaskSchedulerErrorDomain",
  errorCode: 1,
  errorDescription: "Unavailable",
};

describe("createBackgroundRefreshDiagnostics", () => {
  let onState: (state: AppStateStatus) => void;
  const remove = vi.fn();
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDiagnostics).mockReturnValue({ events: [event], overflowCount: 3 });
    vi.mocked(AppState.addEventListener).mockImplementation((_name, callback) => {
      onState = callback;
      return { remove };
    });
  });

  it("replays safe flat native fields once at setup, foreground and handler boundaries", () => {
    vi.mocked(getDiagnostics).mockReturnValue({
      events: [{ ...event, token: "secret", sensorSamples: [1], userId: "secret" }],
      overflowCount: 3,
    });
    const reporter = createBackgroundRefreshDiagnostics();
    expect(logger.info).toHaveBeenCalledExactlyOnceWith(
      "background-refresh",
      "native_background_refresh_event",
      {
        event: "native_background_refresh_event",
        eventId: "11111111-1111-4111-8111-111111111111",
        nativeEvent: "schedule_failed",
        nativeOccurredAt: event.occurredAt,
        nativeSessionId: "33333333-3333-4333-8333-333333333333",
        processId: 42,
        taskId: "44444444-4444-4444-8444-444444444444",
        taskIdentifier: event.taskIdentifier,
        earliestBeginAt: event.earliestBeginAt,
        success: false,
        reason: "submit_failed",
        backgroundRefreshStatus: "denied",
        lowPowerModeEnabled: true,
        errorDomain: event.errorDomain,
        errorCode: 1,
        errorDescription: "Unavailable",
        diagnosticAccountProvenance: "unknown",
        historyOverflowCount: 3,
        trigger: "initial",
      },
    );
    onState("background");
    onState("active");
    reporter.report("received");
    reporter.report("settled");
    expect(logger.info).toHaveBeenCalledTimes(1);
    vi.mocked(getDiagnostics).mockReturnValue({
      events: [{ ...event, eventId: "22222222-2222-4222-8222-222222222222" }],
      overflowCount: 4,
    });
    onState("active");
    expect(logger.info).toHaveBeenLastCalledWith(
      "background-refresh",
      "native_background_refresh_event",
      expect.objectContaining({
        eventId: "22222222-2222-4222-8222-222222222222",
        trigger: "foreground",
        historyOverflowCount: 4,
      }),
    );
    reporter.remove();
    expect(remove).toHaveBeenCalledOnce();
    reporter.report("settled");
    onState("active");
    expect(logger.info).toHaveBeenCalledTimes(2);
  });

  it("reports malformed payloads without leaking their contents and can recover", () => {
    vi.mocked(getDiagnostics).mockReturnValue({
      events: [{ ...event, processId: "secret" }],
      overflowCount: -1,
    });
    const reporter = createBackgroundRefreshDiagnostics();
    expect(logger.info).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      source: "background-refresh-diagnostics",
      trigger: "initial",
    });
    expect(JSON.stringify(vi.mocked(captureException).mock.calls)).not.toContain("secret");
    vi.mocked(getDiagnostics).mockReturnValue({ events: [event], overflowCount: 0 });
    reporter.report("received");
    expect(logger.info).toHaveBeenCalledOnce();
    reporter.remove();
  });

  it("rejects arbitrary bridge identifiers without logging their values", () => {
    vi.mocked(getDiagnostics).mockReturnValue({
      events: [{ ...event, taskId: "private-token" }],
      overflowCount: 0,
    });
    const reporter = createBackgroundRefreshDiagnostics();
    expect(logger.info).not.toHaveBeenCalled();
    expect(captureException).toHaveBeenCalledOnce();
    expect(JSON.stringify(vi.mocked(captureException).mock.calls)).not.toContain("private-token");
    reporter.remove();
  });

  it("reports native read failures and retires telemetry when removed", () => {
    vi.mocked(getDiagnostics).mockImplementation(() => {
      throw new Error("bridge unavailable");
    });
    const reporter = createBackgroundRefreshDiagnostics();
    expect(captureException).toHaveBeenCalledOnce();
    reporter.remove();
    reporter.report("settled");
    expect(captureException).toHaveBeenCalledOnce();
  });

  it("prunes stale replay IDs even when logging a later history fails", () => {
    const reporter = createBackgroundRefreshDiagnostics();
    vi.mocked(getDiagnostics).mockReturnValue({
      events: [{ ...event, eventId: "22222222-2222-4222-8222-222222222222" }],
      overflowCount: 1,
    });
    vi.mocked(logger.info).mockImplementationOnce(() => {
      throw new Error("telemetry unavailable");
    });
    reporter.report("received");
    expect(captureException).toHaveBeenCalledOnce();
    vi.mocked(getDiagnostics).mockReturnValue({ events: [event], overflowCount: 1 });
    reporter.report("settled");
    expect(logger.info).toHaveBeenCalledTimes(3);
    reporter.remove();
  });

  it("bounds replay IDs to the retained native history window", () => {
    const reporter = createBackgroundRefreshDiagnostics();
    for (let index = 0; index < 70; index++) {
      vi.mocked(getDiagnostics).mockReturnValue({
        events: [
          { ...event, eventId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}` },
        ],
        overflowCount: index,
      });
      reporter.report("received");
      reporter.report("settled");
    }
    expect(logger.info).toHaveBeenCalledTimes(71);
    vi.mocked(getDiagnostics).mockReturnValue({ events: [event], overflowCount: 70 });
    reporter.report("received");
    expect(logger.info).toHaveBeenCalledTimes(72);
    reporter.remove();
  });
});
