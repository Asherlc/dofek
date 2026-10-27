export interface ConnectionChangedCall {
  method: "dofek.connectionChanged";
  params: Record<string, never>;
}

export function createConnectionChangedCall(): ConnectionChangedCall {
  return { method: "dofek.connectionChanged", params: {} };
}

export function isConnectionChangedCall(payload: unknown): payload is ConnectionChangedCall {
  const params =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? Reflect.get(payload, "params")
      : null;
  return (
    typeof payload === "object" &&
    payload !== null &&
    !Array.isArray(payload) &&
    Reflect.get(payload, "method") === "dofek.connectionChanged" &&
    typeof params === "object" &&
    params !== null &&
    !Array.isArray(params) &&
    Object.keys(params).length === 0
  );
}
