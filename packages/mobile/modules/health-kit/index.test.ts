const mockQueryAnchoredSamples = vi.hoisted(() => vi.fn());

vi.unmock("./index");

vi.mock("./src/HealthKitModule", () => ({
  default: {
    queryAnchoredSamples: mockQueryAnchoredSamples,
  },
}));

import { queryAnchoredSamples } from "./index";

describe("queryAnchoredSamples", () => {
  it("keeps the opaque anchor inside the native module", async () => {
    const result = {
      samples: [],
      deletedUUIDs: ["deleted-sample"],
    };
    mockQueryAnchoredSamples.mockResolvedValue(result);

    await expect(queryAnchoredSamples("HKQuantityTypeIdentifierStepCount")).resolves.toBe(result);
    expect(mockQueryAnchoredSamples).toHaveBeenCalledExactlyOnceWith(
      "HKQuantityTypeIdentifierStepCount",
    );
  });
});
