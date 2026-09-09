import { describe, expect, it, vi } from "vitest";
import {
  finalizeVisibleSession,
  finalizeVisibleSessionOnAccessLoss,
  getImuTransferFailureReason,
  startVisibleSession,
} from "./session-control.ts";

describe("Zepp session control", () => {
  it("starts recording only after a visible page has verified Dofek credentials and binding", () => {
    const startLogging = vi.fn();
    const actions = { startLogging };

    startVisibleSession(
      { hasCredentials: false, hasImuConnection: true, logging: false, visible: true },
      actions,
    );
    startVisibleSession(
      { hasCredentials: true, hasImuConnection: false, logging: false, visible: true },
      actions,
    );
    startVisibleSession(
      { hasCredentials: true, hasImuConnection: true, logging: false, visible: true },
      actions,
    );
    startVisibleSession(
      { hasCredentials: true, hasImuConnection: true, logging: true, visible: true },
      actions,
    );

    expect(startLogging).toHaveBeenCalledOnce();
  });

  it("does not start recording after the visible page has been destroyed", () => {
    const startLogging = vi.fn();
    const state = {
      hasCredentials: true,
      hasImuConnection: true,
      logging: false,
      visible: false,
    };

    startVisibleSession(state, {
      startLogging,
    });

    expect(startLogging).not.toHaveBeenCalled();
  });

  it("finalizes active visible-page recording and starts transfer when the page closes", () => {
    const events: string[] = [];
    finalizeVisibleSession(
      { logging: true, transferInProgress: false },
      {
        cancelTransfer: () => events.push("cancel"),
        stopLogging: () => events.push("stop"),
        transferStoppedSession: () => events.push("transfer"),
      },
    );

    expect(events).toEqual(["stop", "transfer"]);
  });

  it("cancels a completed-file transfer when the verified account binding is lost", () => {
    const events: string[] = [];

    finalizeVisibleSessionOnAccessLoss(
      {
        hasCredentials: false,
        hasImuConnection: false,
        logging: false,
        transferInProgress: true,
      },
      {
        cancelTransfer: () => events.push("cancel"),
        stopLogging: () => events.push("stop"),
        transferStoppedSession: () => events.push("transfer"),
      },
    );

    expect(events).toEqual(["cancel"]);
  });

  it("keeps recording and transfer state unchanged while access remains valid", () => {
    const events: string[] = [];

    finalizeVisibleSessionOnAccessLoss(
      {
        hasCredentials: true,
        hasImuConnection: true,
        logging: true,
        transferInProgress: true,
      },
      {
        cancelTransfer: () => events.push("cancel"),
        stopLogging: () => events.push("stop"),
        transferStoppedSession: () => events.push("transfer"),
      },
    );

    expect(events).toEqual([]);
  });

  it("cancels an active transfer before finalizing and draining the closing page", () => {
    const events: string[] = [];
    const state = { logging: true, transferInProgress: true };

    finalizeVisibleSession(state, {
      cancelTransfer: () => events.push("cancel"),
      stopLogging: () => events.push("stop"),
      transferStoppedSession: () => events.push("transfer"),
    });

    expect(events).toEqual(["cancel", "stop", "transfer"]);
  });

  it("finalizes recording when the verified account binding is lost", () => {
    const events: string[] = [];

    finalizeVisibleSessionOnAccessLoss(
      {
        hasCredentials: false,
        hasImuConnection: false,
        logging: true,
        transferInProgress: false,
      },
      {
        cancelTransfer: () => events.push("cancel"),
        stopLogging: () => events.push("stop"),
        transferStoppedSession: () => events.push("transfer"),
      },
    );

    expect(events).toEqual(["stop"]);
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
