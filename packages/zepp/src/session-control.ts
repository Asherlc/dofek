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

export interface SessionCall {
  method: "logging.start" | "logging.stop";
  params: Record<string, unknown>;
}

export interface SessionCallPayload {
  method: string;
  params?: Record<string, unknown>;
}

export interface SessionCallHandlers {
  logging: boolean;
  transferInProgress: boolean;
  failedTransferPending: boolean;
  pendingManualExport: boolean;
  applyStartPreferences(params: Record<string, unknown> | undefined): void;
  handleBlockedStart(): void;
  startLogging(): void;
  stopLogging(): void;
  queueManualExport(): void;
  transferStoppedSession(): void;
}

export interface ManualExportQueueState {
  pendingManualExport: boolean;
  logging: boolean;
  failedTransferPending: boolean;
}

export interface ManualExportQueueActions {
  clearManualExportQueue(): void;
  transferStoppedSession(): void;
}

const SESSION_ACTIONS: Record<SessionState, SessionAction> = {
  [SESSION_STATE.IDLE]: {
    command: SESSION_COMMAND.START,
    label: "Start session",
  },
  [SESSION_STATE.RECORDING]: {
    command: SESSION_COMMAND.STOP,
    label: "Stop & transfer",
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

export function createSessionCall(
  command: SessionCommand,
  startParams: Record<string, unknown>,
): SessionCall {
  if (command === SESSION_COMMAND.START) {
    return { method: "logging.start", params: startParams };
  }
  return { method: "logging.stop", params: {} };
}

export function handleSessionCall(
  payload: SessionCallPayload | null,
  handlers: SessionCallHandlers,
): boolean {
  if (payload?.method === "logging.start") {
    if (
      !handlers.logging &&
      (handlers.transferInProgress ||
        handlers.failedTransferPending ||
        handlers.pendingManualExport)
    ) {
      handlers.handleBlockedStart();
      return true;
    }
    if (!handlers.logging) {
      handlers.applyStartPreferences(payload.params);
    }
    handlers.startLogging();
    return true;
  }

  if (payload?.method === "logging.stop") {
    finalizeAndTransfer(handlers);
    return true;
  }

  if (payload?.method === "transfer.start") {
    finalizeAndTransfer(handlers);
    return true;
  }

  return false;
}

function finalizeAndTransfer(handlers: SessionCallHandlers): void {
  if (handlers.logging) {
    handlers.stopLogging();
  }
  if (handlers.transferInProgress) {
    handlers.queueManualExport();
    return;
  }
  if (handlers.failedTransferPending) {
    handlers.queueManualExport();
  }
  handlers.transferStoppedSession();
}

export function drainManualExportQueue(
  state: ManualExportQueueState,
  actions: ManualExportQueueActions,
): boolean {
  if (!state.pendingManualExport || state.logging || state.failedTransferPending) {
    return false;
  }

  actions.clearManualExportQueue();
  actions.transferStoppedSession();
  return true;
}
