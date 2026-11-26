const mockQueryAnchoredSamples = vi.hoisted(() => vi.fn());
const mockCompleteAnchoredQuery = vi.hoisted(() => vi.fn());
const mockQueryCategorySamples = vi.hoisted(() => vi.fn());

vi.unmock("./index");

vi.mock("./src/HealthKitModule", () => ({
  default: {
    completeAnchoredQuery: mockCompleteAnchoredQuery,
    queryAnchoredSamples: mockQueryAnchoredSamples,
    queryCategorySamples: mockQueryCategorySamples,
  },
}));

import { completeAnchoredQuery, queryAnchoredSamples, queryCategorySamples } from "./index";

describe("queryCategorySamples", () => {
  it("forwards category queries to the native module", async () => {
    const samples = [{ uuid: "cycle-start-1" }];
    mockQueryCategorySamples.mockResolvedValue(samples);

    await expect(
      queryCategorySamples(
        "HKCategoryTypeIdentifierMenstrualFlow",
        "2026-07-01T00:00:00.000Z",
        "2026-08-01T00:00:00.000Z",
      ),
    ).resolves.toBe(samples);
    expect(mockQueryCategorySamples).toHaveBeenCalledExactlyOnceWith(
      "HKCategoryTypeIdentifierMenstrualFlow",
      "2026-07-01T00:00:00.000Z",
      "2026-08-01T00:00:00.000Z",
    );
  });
});

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
