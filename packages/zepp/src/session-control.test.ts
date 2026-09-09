import { describe, expect, it, vi } from "vitest";
import {
  finalizeVisibleSession,
  getImuTransferFailureReason,
  startVisibleSession,
} from "./session-control.ts";

describe("Zepp session control", () => {
  it("starts recording only after a visible page has verified Dofek credentials and binding", () => {
    const startLogging = vi.fn();
    const actions = { startLogging, stopLogging: vi.fn(), transferStoppedSession: vi.fn() };

    startVisibleSession({ hasCredentials: false, hasImuConnection: true, logging: false }, actions);
    startVisibleSession({ hasCredentials: true, hasImuConnection: false, logging: false }, actions);
    startVisibleSession({ hasCredentials: true, hasImuConnection: true, logging: false }, actions);

    expect(startLogging).toHaveBeenCalledOnce();
  });

  it("finalizes active visible-page recording and starts transfer when the page closes", () => {
    const events: string[] = [];
    finalizeVisibleSession(
      { logging: true },
      {
        startLogging: () => events.push("start"),
        stopLogging: () => events.push("stop"),
        transferStoppedSession: () => events.push("transfer"),
      },
    );

    expect(events).toEqual(["stop", "transfer"]);
  });

  it.each([
    [{ readyState: "error", error: "Bluetooth interrupted" }, "Bluetooth interrupted"],
    [{ readyState: "error", error: "   " }, "IMU transfer failed."],
    [{ readyState: "error" }, "IMU transfer failed."],
    [{ readyState: "canceled", error: "Watch disconnected" }, "Watch disconnected"],
    [{ readyState: "canceled" }, "IMU transfer was canceled."],
    [{ readyState: "transferred" }, null],
  ])("normalizes terminal transfer failure %#", (event, expected) => {
    expect(getImuTransferFailureReason(event, "IMU transfer failed.")).toBe(expected);
  });
});
