/**
 * Server URL, set at build time via EXPO_PUBLIC_SERVER_URL.
 * Defaults to https://dofek.asherlc.com when not set.
 */
export const SERVER_URL = (
  process.env.EXPO_PUBLIC_SERVER_URL || "https://dofek.asherlc.com"
).replace(/\/+$/, "");

/** Build the tRPC API URL from the server base URL. */
export function getTrpcUrl(serverUrl: string): string {
  return `${serverUrl}/api/trpc`;
}
