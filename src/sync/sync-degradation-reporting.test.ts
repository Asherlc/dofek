import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger.ts";
import { syncDegradationsTotal } from "../sync-metrics.ts";
import { reportSyncDegradation } from "./sync-degradation-reporting.ts";

vi.mock("../sync-metrics.ts", () => ({
  syncDegradationsTotal: {
    add: vi.fn(),
  },
}));

describe("reportSyncDegradation", () => {
  beforeEach(() => {
    vi.mocked(syncDegradationsTotal.add).mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs and records a sync degradation metric without raw cursor context", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockReturnValue(logger);
    const sensitiveContext = {
      accessToken: "do-not-log-token",
      authHeader: "do-not-log-auth-header",
      clientSecret: "do-not-log-client-secret",
      cursor: "do-not-log-cursor",
      password: "do-not-log-password",
      rawCursor: "do-not-log-this",
    };

    reportSyncDegradation({
      kind: "pagination_stalled",
      providerId: "whoop",
      stepName: "developer_workouts",
      message: "WHOOP returned a repeated workout cursor",
      externalId: "workout-123",
      context: {
        ...sensitiveContext,
        cursorFingerprint: "abcdef123456",
        kind: "wrong-kind",
        message: "wrong message",
        providerId: "wrong-provider",
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
    for (const [sensitiveContextKey, sensitiveContextValue] of Object.entries(sensitiveContext)) {
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ [sensitiveContextKey]: sensitiveContextValue }),
      );
    }
    expect(syncDegradationsTotal.add).toHaveBeenCalledWith(1, {
      provider: "whoop",
      step_name: "developer_workouts",
      degradation_kind: "pagination_stalled",
    });
  });
});
