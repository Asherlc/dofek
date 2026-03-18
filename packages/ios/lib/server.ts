import * as SecureStore from "expo-secure-store";

const SERVER_URL_KEY = "dofek_server_url";

/** Save the server base URL (e.g. "https://dofek.asherlc.com"). */
export async function saveServerUrl(url: string): Promise<void> {
  // Normalize: strip trailing slash
  const normalized = url.replace(/\/+$/, "");
  await SecureStore.setItemAsync(SERVER_URL_KEY, normalized);
}

/** Get the saved server URL, or null if not configured. */
export async function getServerUrl(): Promise<string | null> {
  return SecureStore.getItemAsync(SERVER_URL_KEY);
}

/** Clear the saved server URL. */
export async function clearServerUrl(): Promise<void> {
  await SecureStore.deleteItemAsync(SERVER_URL_KEY);
}

/** Build the tRPC API URL from the server base URL. */
export function getTrpcUrl(serverUrl: string): string {
  return `${serverUrl}/api/trpc`;
}
