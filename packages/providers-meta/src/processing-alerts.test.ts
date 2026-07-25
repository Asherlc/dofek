import { describe, expect, it } from "vitest";
import { PROCESSING_ALERT_ACTIONS } from "./processing-alerts.ts";

describe("processing alert contract", () => {
  it("exposes every supported customer action", () => {
    expect(PROCESSING_ALERT_ACTIONS).toEqual([
      "retry_sync",
      "reconnect",
      "retry_import",
      "contact_support",
    ]);
  });
});
