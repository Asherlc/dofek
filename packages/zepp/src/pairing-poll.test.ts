import { describe, expect, it } from "vitest";
import { shouldRetryPairingPollFailure } from "./pairing-poll.ts";
import type { ZeppFetchSummary } from "./zepp-fetch.ts";

function makeSummary(status: number | null): ZeppFetchSummary {
  return {
    body: null,
    errorMessage: status === null ? "Network unavailable" : `HTTP ${status}`,
    ok: false,
    status,
  };
}

describe("shouldRetryPairingPollFailure", () => {
  it("does not retry expired or missing pairing codes", () => {
    expect(shouldRetryPairingPollFailure(makeSummary(404))).toBe(false);
  });

  it("retries transient server and network failures", () => {
    expect(shouldRetryPairingPollFailure(makeSummary(500))).toBe(true);
    expect(shouldRetryPairingPollFailure(makeSummary(null))).toBe(true);
  });
});
