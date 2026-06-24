import { providerLabel } from "./providers.ts";

/** Provider ID for WHOOP strap data ingested via the iOS app's BLE connection. */
export const WHOOP_BLE_PROVIDER_ID = "whoop_ble";

export interface PushProviderDefinition {
  id: string;
  name: string;
  authType: "push:mobile";
  description: string;
}

/** Providers that receive data via mobile push sync rather than server-side pull jobs. */
export const PUSH_PROVIDERS: readonly PushProviderDefinition[] = [
  {
    id: WHOOP_BLE_PROVIDER_ID,
    name: providerLabel(WHOOP_BLE_PROVIDER_ID),
    authType: "push:mobile",
    description: "Synced from the iOS app when your WHOOP strap is nearby.",
  },
] as const;

const PUSH_PROVIDER_ID_SET = new Set(PUSH_PROVIDERS.map((provider) => provider.id));

export function isPushProvider(id: string): boolean {
  return PUSH_PROVIDER_ID_SET.has(id);
}
