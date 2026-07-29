export type ProviderHealthStatus = "healthy" | "neutral" | "warning";

export interface ProviderHealthIndicator {
  label: string;
  status: ProviderHealthStatus;
}

export interface ProviderHealth {
  connection: ProviderHealthIndicator;
  authorization: ProviderHealthIndicator;
  requiresReconnect: boolean;
}

export function providerHealth(input: {
  authorized: boolean;
  needsReauth: boolean;
  requiresAuthorization: boolean;
}): ProviderHealth {
  const connection: ProviderHealthIndicator = input.authorized
    ? { label: "Connected", status: "healthy" }
    : { label: "Not connected", status: "neutral" };

  if (input.needsReauth) {
    return {
      connection,
      authorization: { label: "Reconnect required", status: "warning" },
      requiresReconnect: true,
    };
  }

  return {
    connection,
    authorization: input.requiresAuthorization
      ? input.authorized
        ? { label: "Active", status: "healthy" }
        : { label: "Not connected", status: "neutral" }
      : { label: "Not required", status: "neutral" },
    requiresReconnect: false,
  };
}
