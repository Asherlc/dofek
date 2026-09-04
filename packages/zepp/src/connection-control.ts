export interface ConnectionChangedCall {
  method: "dofek.connectionChanged";
  params: Record<string, never>;
}

export function createConnectionChangedCall(): ConnectionChangedCall {
  return { method: "dofek.connectionChanged", params: {} };
}

export function isConnectionChangedCall(payload: unknown): payload is ConnectionChangedCall {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return false;
  }
  const params = Reflect.get(payload, "params");
  return (
    Reflect.get(payload, "method") === "dofek.connectionChanged" &&
    typeof params === "object" &&
    params !== null &&
    !Array.isArray(params) &&
    Object.keys(params).length === 0
  );
}
