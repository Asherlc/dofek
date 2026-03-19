/** The production server URL. */
export const SERVER_URL = "https://dofek.asherlc.com";

/** Build the tRPC API URL from the server base URL. */
export function getTrpcUrl(serverUrl: string): string {
  return `${serverUrl}/api/trpc`;
}
