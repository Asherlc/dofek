const mockQueryAnchoredSamples = vi.hoisted(() => vi.fn());
const mockCompleteAnchoredQuery = vi.hoisted(() => vi.fn());

vi.unmock("./index");

vi.mock("./src/HealthKitModule", () => ({
  default: {
    completeAnchoredQuery: mockCompleteAnchoredQuery,
    queryAnchoredSamples: mockQueryAnchoredSamples,
  },
}));

import { completeAnchoredQuery, queryAnchoredSamples } from "./index";

describe("queryAnchoredSamples", () => {
  it("keeps the opaque anchor inside the native module", async () => {
    const result = {
      queryId: "query-1",
      samples: [],
      deletedUUIDs: ["deleted-sample"],
    };
    mockQueryAnchoredSamples.mockResolvedValue(result);

    await expect(
      queryAnchoredSamples("HKQuantityTypeIdentifierStepCount", "2026-07-27T00:00:00.000Z"),
    ).resolves.toBe(result);
    expect(mockQueryAnchoredSamples).toHaveBeenCalledExactlyOnceWith(
      "HKQuantityTypeIdentifierStepCount",
      "2026-07-27T00:00:00.000Z",
    );
  });

  it("commits the opaque native anchor only after upload success", async () => {
    mockCompleteAnchoredQuery.mockResolvedValue(true);

    await expect(
      completeAnchoredQuery("HKQuantityTypeIdentifierHeartRate", "query-1", true),
    ).resolves.toBe(true);
    expect(mockCompleteAnchoredQuery).toHaveBeenCalledExactlyOnceWith(
      "HKQuantityTypeIdentifierHeartRate",
      "query-1",
      true,
    );
  });
});
