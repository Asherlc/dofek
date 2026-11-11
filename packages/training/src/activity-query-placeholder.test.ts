import { describe, expect, it } from "vitest";
import { activityQueryPlaceholder } from "./activity-query-placeholder.ts";

describe("activityQueryPlaceholder", () => {
  it("preserves cached observations for the same activity during source changes", () => {
    const data = { window: { startedAt: "2026-10-30T12:00:00Z" }, points: [91] };
    expect(
      activityQueryPlaceholder("current")(data, {
        queryKey: [
          ["activity", "heartRateContext"],
          { input: { id: "current", heartRateSourceId: "whoop" } },
        ],
      }),
    ).toBe(data);
  });
  it.each([undefined, [], [null, null], [null, { input: {} }], [null, { input: { id: "other" } }]])(
    "does not carry another activity's timeline across navigation: %j",
    (queryKey) => {
      expect(
        activityQueryPlaceholder("current")({ points: [91] }, queryKey ? { queryKey } : undefined),
      ).toBeUndefined();
    },
  );
});
