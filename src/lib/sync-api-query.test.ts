import { describe, expect, it } from "vitest";
import { syncApiQueryKey } from "./sync-api-query.ts";

describe("syncApiQueryKey", () => {
  it("builds a stable key regardless of filter insertion order", () => {
    expect(
      syncApiQueryKey({
        path: "metrics-service/v1/metrics",
        filters: {
          end: "2026-05-03T00:00:00.000Z",
          name: "heart_rate",
          start: "2026-05-01T00:00:00.000Z",
          step: 6,
        },
      }),
    ).toBe(
      syncApiQueryKey({
        path: "metrics-service/v1/metrics",
        filters: {
          name: "heart_rate",
          start: "2026-05-01T00:00:00.000Z",
          end: "2026-05-03T00:00:00.000Z",
          step: 6,
        },
      }),
    );
  });
});
