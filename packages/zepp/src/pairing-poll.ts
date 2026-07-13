import type { ZeppFetchSummary } from "./zepp-fetch.ts";

export function shouldRetryPairingPollFailure(summary: ZeppFetchSummary): boolean {
  return summary.status !== 404;
}
