import { providerLabel } from "./providers.ts";

/** Provider ID for WHOOP strap data ingested via the iOS app's BLE connection. */
export const WHOOP_BLE_PROVIDER_ID = "whoop_ble";

/**
 * Provider ID for a standard Bluetooth heart-rate monitor (Heart Rate Service
 * 0x180D) ingested via the iOS app's BLE connection during activity recording.
 */
export const BLE_HEART_RATE_PROVIDER_ID = "ble_heart_rate";

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
  {
    id: BLE_HEART_RATE_PROVIDER_ID,
    name: providerLabel(BLE_HEART_RATE_PROVIDER_ID),
    authType: "push:mobile",
    description: "Synced from the iOS app when a Bluetooth heart-rate monitor is connected.",
  },
] as const;

const PUSH_PROVIDER_ID_SET = new Set(PUSH_PROVIDERS.map((provider) => provider.id));

export function isPushProvider(id: string): boolean {
  return PUSH_PROVIDER_ID_SET.has(id);
}
