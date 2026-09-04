import { describe, expect, it, vi } from "vitest";
import {
  createSessionCall,
  drainManualExportQueue,
  getImuTransferFailureReason,
  getSessionAction,
  handleSessionCall,
  parseSessionCommand,
  parseSessionState,
  SESSION_COMMAND,
  SESSION_STATE,
} from "./session-control.ts";
import { makeSessionCallHandlers } from "./test-helpers.ts";

describe("Zepp session control", () => {
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

  it("offers an explicit start action while idle", () => {
    expect(getSessionAction(SESSION_STATE.IDLE)).toEqual({
      command: SESSION_COMMAND.START,
      label: "Start session",
    });
  });

  it("offers an explicit stop action while recording", () => {
    expect(getSessionAction(SESSION_STATE.RECORDING)).toEqual({
      command: SESSION_COMMAND.STOP,
      label: "Stop & transfer",
    });
  });

  it.each([
    [SESSION_COMMAND.START, SESSION_COMMAND.START],
    [SESSION_COMMAND.STOP, SESSION_COMMAND.STOP],
    [" start ", null],
    ["record", null],
    [null, null],
    [undefined, null],
  ])("parses session command %j as %j", (value, expected) => {
    expect(parseSessionCommand(value)).toBe(expected);
  });

  it.each([
    [SESSION_STATE.RECORDING, SESSION_STATE.RECORDING],
    [SESSION_STATE.IDLE, SESSION_STATE.IDLE],
    ["logging", SESSION_STATE.IDLE],
    [null, SESSION_STATE.IDLE],
  ])("parses session state %j as %j", (value, expected) => {
    expect(parseSessionState(value)).toBe(expected);
  });

  it("maps Settings commands to explicit watch calls", () => {
    const preferences = { freqModeIndex: 2 };

    expect(createSessionCall(SESSION_COMMAND.START, preferences)).toEqual({
      method: "logging.start",
      params: preferences,
    });
    expect(createSessionCall(SESSION_COMMAND.STOP, preferences)).toEqual({
      method: "logging.stop",
      params: {},
    });
  });

  it("applies start preferences before starting an idle session", () => {
    const events: string[] = [];
    const params = { freqModeIndex: 2 };

    expect(
      handleSessionCall(
        { method: "logging.start", params },
        makeSessionCallHandlers({
          applyStartPreferences: (received) => {
            expect(received).toBe(params);
            events.push("preferences");
          },
          startLogging: () => events.push("start"),
        }),
      ),
    ).toBe(true);
    expect(events).toEqual(["preferences", "start"]);
  });

  it("does not replace preferences for a session that is already active", () => {
    const applyStartPreferences = vi.fn();
    const startLogging = vi.fn();

    expect(
      handleSessionCall(
        { method: "logging.start", params: { freqModeIndex: 2 } },
        makeSessionCallHandlers({
          logging: true,
          applyStartPreferences,
          startLogging,
        }),
      ),
    ).toBe(true);
    expect(applyStartPreferences).not.toHaveBeenCalled();
    expect(startLogging).toHaveBeenCalledOnce();
  });

  it("stops and transfers an active session on an explicit stop call", () => {
    const events: string[] = [];

    expect(
      handleSessionCall(
        { method: "logging.stop" },
        makeSessionCallHandlers({
          logging: true,
          stopLogging: () => events.push("stop"),
          transferStoppedSession: () => events.push("transfer"),
        }),
      ),
    ).toBe(true);
    expect(events).toEqual(["stop", "transfer"]);
  });

  it("queues an explicit stop behind an active automatic transfer", () => {
    const events: string[] = [];

    expect(
      handleSessionCall(
        { method: "logging.stop" },
        makeSessionCallHandlers({
          logging: true,
          transferInProgress: true,
          stopLogging: () => events.push("stop"),
          queueManualExport: () => events.push("queue"),
          transferStoppedSession: () => events.push("transfer"),
        }),
      ),
    ).toBe(true);
    expect(events).toEqual(["stop", "queue"]);
  });

  it.each([
    {
      name: "a transfer is active",
      transferInProgress: true,
      failedTransferPending: false,
      pendingManualExport: false,
    },
    {
      name: "a failed transfer awaits retry",
      transferInProgress: false,
      failedTransferPending: true,
      pendingManualExport: false,
    },
    {
      name: "the finalized session is queued",
      transferInProgress: false,
      failedTransferPending: false,
      pendingManualExport: true,
    },
  ])("blocks a new session while $name", (state) => {
    const applyStartPreferences = vi.fn();
    const handleBlockedStart = vi.fn();
    const startLogging = vi.fn();

    expect(
      handleSessionCall(
        { method: "logging.start", params: { freqModeIndex: 2 } },
        makeSessionCallHandlers({
          ...state,
          applyStartPreferences,
          handleBlockedStart,
          startLogging,
        }),
      ),
    ).toBe(true);
    expect(handleBlockedStart).toHaveBeenCalledOnce();
    expect(applyStartPreferences).not.toHaveBeenCalled();
    expect(startLogging).not.toHaveBeenCalled();
  });

  it("stops and immediately transfers when no transfer is active", () => {
    const events: string[] = [];

    expect(
      handleSessionCall(
        { method: "transfer.start" },
        makeSessionCallHandlers({
          logging: true,
          stopLogging: () => events.push("stop"),
          queueManualExport: () => events.push("queue"),
          transferStoppedSession: () => events.push("transfer"),
        }),
      ),
    ).toBe(true);
    expect(events).toEqual(["stop", "transfer"]);
  });

  it("transfers an idle finalized session without stopping again or queueing", () => {
    const stopLogging = vi.fn();
    const queueManualExport = vi.fn();
    const transferStoppedSession = vi.fn();

    expect(
      handleSessionCall(
        { method: "transfer.start" },
        makeSessionCallHandlers({
          stopLogging,
          queueManualExport,
          transferStoppedSession,
        }),
      ),
    ).toBe(true);
    expect(stopLogging).not.toHaveBeenCalled();
    expect(queueManualExport).not.toHaveBeenCalled();
    expect(transferStoppedSession).toHaveBeenCalledOnce();
  });

  it("queues manual export behind an active transfer", () => {
    const events: string[] = [];

    expect(
      handleSessionCall(
        { method: "transfer.start" },
        makeSessionCallHandlers({
          logging: true,
          transferInProgress: true,
          stopLogging: () => events.push("stop"),
          queueManualExport: () => events.push("queue"),
          transferStoppedSession: () => events.push("transfer"),
        }),
      ),
    ).toBe(true);
    expect(events).toEqual(["stop", "queue"]);
  });

  it("queues the finalized file behind a failed automatic transfer retry", () => {
    const events: string[] = [];
    const stopLogging = vi.fn();

    expect(
      handleSessionCall(
        { method: "transfer.start" },
        makeSessionCallHandlers({
          failedTransferPending: true,
          stopLogging,
          queueManualExport: () => events.push("queue"),
          transferStoppedSession: () => events.push("transfer"),
        }),
      ),
    ).toBe(true);
    expect(stopLogging).not.toHaveBeenCalled();
    expect(events).toEqual(["queue", "transfer"]);
  });

  it("leaves unrelated watch calls for the page to handle", () => {
    expect(handleSessionCall({ method: "health.collect" }, makeSessionCallHandlers())).toBe(false);
  });

  it("ignores an empty watch call", () => {
    expect(handleSessionCall(null, makeSessionCallHandlers())).toBe(false);
  });

  it("drains a queued manual export after the active transfer succeeds", () => {
    const events: string[] = [];

    expect(
      drainManualExportQueue(
        {
          pendingManualExport: true,
          logging: false,
          failedTransferPending: false,
        },
        {
          clearManualExportQueue: () => events.push("clear"),
          transferStoppedSession: () => events.push("transfer"),
        },
      ),
    ).toBe(true);
    expect(events).toEqual(["clear", "transfer"]);
  });

  it.each([
    {
      name: "no export is pending",
      pendingManualExport: false,
      logging: false,
      failedTransferPending: false,
    },
    {
      name: "recording is still active",
      pendingManualExport: true,
      logging: true,
      failedTransferPending: false,
    },
    {
      name: "a failed transfer awaits retry",
      pendingManualExport: true,
      logging: false,
      failedTransferPending: true,
    },
  ])("keeps the manual export queue unchanged when $name", (state) => {
    const clearManualExportQueue = vi.fn();
    const transferStoppedSession = vi.fn();

    expect(drainManualExportQueue(state, { clearManualExportQueue, transferStoppedSession })).toBe(
      false,
    );
    expect(clearManualExportQueue).not.toHaveBeenCalled();
    expect(transferStoppedSession).not.toHaveBeenCalled();
  });
});
