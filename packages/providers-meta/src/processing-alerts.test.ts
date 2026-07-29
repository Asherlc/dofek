import { describe, expect, it } from "vitest";
import { PROCESSING_ALERT_ACTIONS, PROCESSING_ALERTS_EMPTY_PREVIEW } from "./processing-alerts.ts";

describe("processing alert contract", () => {
  it("exposes every supported customer action", () => {
    expect(PROCESSING_ALERT_ACTIONS).toEqual([
      "retry_sync",
      "reconnect",
      "retry_import",
      "contact_support",
    ]);
  });

  it("describes the exact structure of a future alert without inventing one", () => {
    expect(PROCESSING_ALERTS_EMPTY_PREVIEW).toEqual({
      title: "Nothing needs your attention",
      message: "New sync, connection, and import problems will appear here.",
      previewTitle: "When an alert appears, it will show",
      previewItems: ["What happened", "When it happened", "What to do next"],
      note: "Only real problems detected for your account are shown.",
    });
  });
});
