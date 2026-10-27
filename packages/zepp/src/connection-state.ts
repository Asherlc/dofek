export type ConnectionState =
  | "disconnected"
  | "pairing"
  | "checking"
  | "connected"
  | "disconnecting"
  | "error";

export interface ConnectionActions {
  showConnectionForm: boolean;
  showPairing: boolean;
  showLogin: boolean;
  showCheck: boolean;
  showSync: boolean;
  showDisconnect: boolean;
}

export function parseConnectionState(value: unknown): ConnectionState {
  if (value === "not connected") {
    return "disconnected";
  }
  switch (value) {
    case "disconnected":
    case "pairing":
    case "checking":
    case "connected":
    case "disconnecting":
    case "error":
      return value;
    default:
      return "disconnected";
  }
}

export function deriveConnectionActions(
  state: ConnectionState,
  hasToken: boolean,
): ConnectionActions {
  const connected = state === "connected" && hasToken;
  const canConnect =
    state === "disconnected" ||
    (state === "error" && !hasToken) ||
    (state === "connected" && !hasToken);
  const canCheck = connected || (state === "error" && hasToken);
  const canDisconnect =
    connected || state === "pairing" || state === "checking" || (state === "error" && hasToken);

  return {
    showConnectionForm: canConnect,
    showPairing: canConnect,
    showLogin: canConnect,
    showCheck: canCheck,
    showSync: connected,
    showDisconnect: canDisconnect,
  };
}
