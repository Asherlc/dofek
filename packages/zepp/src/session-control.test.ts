import { describe, expect, it } from "vitest";
import {
  getSessionAction,
  parseSessionCommand,
  parseSessionState,
  SESSION_COMMAND,
  SESSION_STATE,
} from "./session-control.ts";

describe("Zepp session control", () => {
  it("offers an explicit start action while idle", () => {
    expect(getSessionAction(SESSION_STATE.IDLE)).toEqual({
      command: SESSION_COMMAND.START,
      label: "Start session",
    });
  });

  it("offers an explicit stop action while recording", () => {
    expect(getSessionAction(SESSION_STATE.RECORDING)).toEqual({
      command: SESSION_COMMAND.STOP,
      label: "Stop & finalize",
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
});
