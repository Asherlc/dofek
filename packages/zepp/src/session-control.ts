export const SESSION_STATE = {
  IDLE: "idle",
  RECORDING: "recording",
} as const;

export type SessionState = (typeof SESSION_STATE)[keyof typeof SESSION_STATE];

export const SESSION_COMMAND = {
  START: "start",
  STOP: "stop",
} as const;

export type SessionCommand = (typeof SESSION_COMMAND)[keyof typeof SESSION_COMMAND];

export interface SessionAction {
  command: SessionCommand;
  label: string;
}

const SESSION_ACTIONS: Record<SessionState, SessionAction> = {
  [SESSION_STATE.IDLE]: {
    command: SESSION_COMMAND.START,
    label: "Start session",
  },
  [SESSION_STATE.RECORDING]: {
    command: SESSION_COMMAND.STOP,
    label: "Stop & finalize",
  },
};

export function getSessionAction(state: SessionState): SessionAction {
  return SESSION_ACTIONS[state];
}

export function parseSessionCommand(value: unknown): SessionCommand | null {
  if (value === SESSION_COMMAND.START || value === SESSION_COMMAND.STOP) {
    return value;
  }
  return null;
}

export function parseSessionState(value: unknown): SessionState {
  return value === SESSION_STATE.RECORDING ? SESSION_STATE.RECORDING : SESSION_STATE.IDLE;
}
