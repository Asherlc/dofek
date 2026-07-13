import type { ZeppFetchSummary } from "./zepp-fetch.ts";

export function shouldRetryPairingPollFailure(summary: ZeppFetchSummary): boolean {
  if (summary.status === null) return true;
  return summary.status === 429 || summary.status >= 500;
}
