import { describe, expect, it } from "vitest";
import { providerDangerZoneCopy } from "./provider-disconnect.ts";

describe("providerDangerZoneCopy", () => {
  it("names the provider and explains what disconnect removes and retains", () => {
    expect(providerDangerZoneCopy("Garmin")).toMatchObject({
      disconnectActionLabel: "Disconnect Garmin",
      disconnectPendingLabel: "Disconnecting Garmin...",
      disconnectTitle: "Disconnect Garmin?",
      disconnectDescription:
        "Disconnecting Garmin removes its saved authorization and stops future syncs. Data already imported into Dofek is kept.",
    });
  });

  it("distinguishes data deletion from connection state", () => {
    expect(providerDangerZoneCopy("WHOOP (Cloud)").deleteDescription).toBe(
      "Permanently delete every WHOOP (Cloud) record from Dofek. This does not change whether WHOOP (Cloud) is connected.",
    );
  });
});
