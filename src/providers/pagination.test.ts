import { describe, expect, it } from "vitest";
import { fetchProviderPages } from "./pagination.ts";

describe("fetchProviderPages", () => {
  it("returns fetched items and reports a degradation when the next cursor repeats", async () => {
    const result = await fetchProviderPages({
      providerId: "whoop",
      stepName: "developer_workouts",
      initialCursor: "page-1",
      fetchPage: async () => ({
        items: ["workout-1"],
        nextCursor: "page-1",
      }),
    });

    expect(result.items).toEqual(["workout-1"]);
    expect(result.degradations).toEqual([
      expect.objectContaining({
        kind: "pagination_stalled",
        providerId: "whoop",
        stepName: "developer_workouts",
      }),
    ]);
    expect(result.completed).toBe(false);
  });

  it("reports empty page with cursor as degraded and does not fetch another page", async () => {
    let calls = 0;

    const result = await fetchProviderPages({
      providerId: "oura",
      stepName: "workouts",
      fetchPage: async () => {
        calls += 1;
        return {
          items: [],
          nextCursor: "page-2",
        };
      },
    });

    expect(calls).toBe(1);
    expect(result.items).toEqual([]);
    expect(result.degradations[0]?.kind).toBe("pagination_empty_page_with_cursor");
    expect(result.completed).toBe(false);
  });

  it("stops normally when the provider stop rule is met", async () => {
    const result = await fetchProviderPages({
      providerId: "peloton",
      stepName: "workouts",
      fetchPage: async () => ({
        items: ["old-workout"],
        nextCursor: "page-2",
      }),
      shouldStopAfterPage: () => true,
    });

    expect(result.items).toEqual(["old-workout"]);
    expect(result.degradations).toEqual([]);
    expect(result.completed).toBe(true);
    expect(result.stoppedByProviderRule).toBe(true);
  });
});
