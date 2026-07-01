import { captureMessage } from "@sentry/node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger.ts";
import { reportSyncDegradation } from "./sync-degradation-reporting.ts";

vi.mock("@sentry/node", () => ({
  captureMessage: vi.fn(),
}));

describe("reportSyncDegradation", () => {
  beforeEach(() => {
    vi.mocked(captureMessage).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs and sends a warning-level Sentry message without raw cursor context", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockReturnValue(logger);

    reportSyncDegradation({
      kind: "pagination_stalled",
      providerId: "whoop",
      stepName: "developer_workouts",
      message: "WHOOP returned a repeated workout cursor",
      externalId: "workout-123",
      context: {
        accessToken: "do-not-log-token",
        cursor: "do-not-log-cursor",
        cursorFingerprint: "abcdef123456",
        kind: "wrong-kind",
        message: "wrong message",
        providerId: "wrong-provider",
        rawCursor: "do-not-log-this",
        pagesFetched: 1,
        stepName: "wrong-step",
      },
    });

    expect(warnSpy).toHaveBeenCalledWith(
      "[provider-sync] Degraded provider sync step",
      expect.objectContaining({
        kind: "pagination_stalled",
        providerId: "whoop",
        stepName: "developer_workouts",
        message: "WHOOP returned a repeated workout cursor",
        externalId: "workout-123",
        cursorFingerprint: "abcdef123456",
        pagesFetched: 1,
      }),
    );
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ rawCursor: "do-not-log-this" }),
    );
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        accessToken: "do-not-log-token",
        cursor: "do-not-log-cursor",
      }),
    );
    expect(captureMessage).toHaveBeenCalledWith("Provider sync degraded", {
      level: "warning",
      tags: {
        providerId: "whoop",
        stepName: "developer_workouts",
        degradationKind: "pagination_stalled",
      },
      extra: expect.objectContaining({
        externalId: "workout-123",
        cursorFingerprint: "abcdef123456",
        pagesFetched: 1,
      }),
    });
    expect(captureMessage).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        extra: expect.objectContaining({
          accessToken: "do-not-log-token",
          cursor: "do-not-log-cursor",
          rawCursor: "do-not-log-this",
        }),
      }),
    );
  });
});
