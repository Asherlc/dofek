import { captureMessage } from "@sentry/node";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { logger } from "../logger.ts";
import { reportSyncDegradation } from "./sync-degradation-reporting.ts";

vi.mock("@sentry/node", () => ({
  captureMessage: vi.fn(),
}));

describe("reportSyncDegradation", () => {
  beforeEach(() => {
    vi.mocked(captureMessage).mockClear();
  });

  it("logs and sends a warning-level Sentry message without raw cursor context", () => {
    const warnSpy = vi.spyOn(logger, "warn").mockReturnValue(logger);

    reportSyncDegradation({
      kind: "pagination_stalled",
      providerId: "whoop",
      stepName: "developer_workouts",
      message: "WHOOP returned a repeated workout cursor",
      context: {
        cursorFingerprint: "abcdef123456",
        rawCursor: "do-not-log-this",
        pagesFetched: 1,
      },
    });

    expect(warnSpy).toHaveBeenCalledWith(
      "[provider-sync] Degraded provider sync step",
      expect.objectContaining({
        kind: "pagination_stalled",
        providerId: "whoop",
        stepName: "developer_workouts",
        cursorFingerprint: "abcdef123456",
        pagesFetched: 1,
      }),
    );
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ rawCursor: "do-not-log-this" }),
    );
    expect(captureMessage).toHaveBeenCalledWith("Provider sync degraded", {
      level: "warning",
      tags: {
        providerId: "whoop",
        stepName: "developer_workouts",
        degradationKind: "pagination_stalled",
      },
      extra: expect.not.objectContaining({ rawCursor: "do-not-log-this" }),
    });

    warnSpy.mockRestore();
  });
});
