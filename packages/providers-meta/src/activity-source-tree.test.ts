import { describe, expect, it } from "vitest";
import { activitySourceNodePresentation } from "./activity-source-tree.ts";

describe("activitySourceNodePresentation", () => {
  it.each([
    ["whoop", "WHOOP (Cloud)", "WHOOP", "cloud"],
    ["whoop_ble", "WHOOP (Bluetooth)", "WHOOP", "bluetooth"],
    ["whoop", "WHOOP 4.0", "WHOOP 4.0", null],
    ["apple_health", "Apple Health", "Apple Health", null],
  ])("presents %s source %s", (providerId, label, displayName, kind) => {
    const presentation = activitySourceNodePresentation({
      id: "record",
      providerId,
      label,
      sourceName: "Apple Watch",
      description: null,
      url: null,
      children: [],
    });
    expect(presentation.displayName).toBe(displayName);
    expect(presentation.attribution?.kind ?? null).toBe(kind);
  });
});
