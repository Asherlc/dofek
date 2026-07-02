import { describe, expect, it } from "vitest";
import { fetchProviderPages } from "./pagination.ts";

describe("fetchProviderPages", () => {
  it("completes normally when the provider returns no next cursor", async () => {
    let calls = 0;

    const result = await fetchProviderPages<string, string>({
      providerId: "whoop",
      stepName: "developer_workouts",
      fetchPage: async (cursor) => {
        calls += 1;
        expect(cursor).toBeUndefined();
        return {
          items: ["workout-1", "workout-2"],
          nextCursor: null,
        };
      },
    });

    expect(calls).toBe(1);
    expect(result).toEqual({
      items: ["workout-1", "workout-2"],
      degradations: [],
      pagesFetched: 1,
      finalCursor: null,
      completed: true,
      stoppedByProviderRule: false,
    });
  });

  it("returns fetched items and reports a degradation when the next cursor repeats", async () => {
    let calls = 0;

    const result = await fetchProviderPages<string, string>({
      providerId: "whoop",
      stepName: "developer_workouts",
      initialCursor: "page-1",
      fetchPage: async () => {
        calls += 1;
        return {
          items: ["workout-1"],
          nextCursor: "page-1",
        };
      },
    });

    expect(calls).toBe(1);
    expect(result.items).toEqual(["workout-1"]);
    expect(result.degradations).toEqual([
      expect.objectContaining({
        kind: "pagination_stalled",
        providerId: "whoop",
        stepName: "developer_workouts",
        context: {
          cursorFingerprint: expect.any(String),
          pagesFetched: 1,
        },
      }),
    ]);
    expect(result.pagesFetched).toBe(1);
    expect(result.finalCursor).toBeNull();
    expect(result.completed).toBe(false);
    expect(result.stoppedByProviderRule).toBe(false);
  });

  it("reports a degradation when a later page returns a previously seen cursor", async () => {
    const pages = [
      { items: ["workout-1"], nextCursor: "page-2" },
      { items: ["workout-2"], nextCursor: "page-3" },
      { items: ["workout-3"], nextCursor: "page-2" },
    ];
    const requestedCursors: Array<string | undefined> = [];

    const result = await fetchProviderPages<string, string>({
      providerId: "whoop",
      stepName: "developer_workouts",
      initialCursor: "page-1",
      fetchPage: async (cursor) => {
        requestedCursors.push(cursor);
        const page = pages.shift();
        if (!page) throw new Error("unexpected extra page fetch");
        return page;
      },
    });

    expect(requestedCursors).toEqual(["page-1", "page-2", "page-3"]);
    expect(result.items).toEqual(["workout-1", "workout-2", "workout-3"]);
    expect(result.degradations).toEqual([
      expect.objectContaining({
        kind: "pagination_stalled",
        message: "Provider returned a previously seen pagination cursor",
      }),
    ]);
    expect(result.degradations[0]?.context).toEqual({
      cursorFingerprint: expect.any(String),
      pagesFetched: 3,
    });
    expect(result.finalCursor).toBeNull();
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
    expect(result.finalCursor).toBeNull();
    expect(result.completed).toBe(false);
  });

  it("reports max page count as degraded before fetching beyond the configured limit", async () => {
    const requestedCursors: Array<string | undefined> = [];

    const result = await fetchProviderPages({
      providerId: "fitbit",
      stepName: "activities",
      maxPages: 1,
      fetchPage: async (cursor) => {
        requestedCursors.push(cursor);
        return {
          items: [`item-${requestedCursors.length}`],
          nextCursor: `page-${requestedCursors.length + 1}`,
        };
      },
    });

    expect(requestedCursors).toEqual([undefined]);
    expect(result.items).toEqual(["item-1"]);
    expect(result.pagesFetched).toBe(1);
    expect(result.finalCursor).toBeNull();
    expect(result.degradations).toEqual([
      expect.objectContaining({
        kind: "pagination_max_pages_exceeded",
        context: {
          cursorFingerprint: expect.any(String),
          pagesFetched: 1,
        },
      }),
    ]);
    expect(result.completed).toBe(false);
  });

  it("treats numeric and string cursor values as different page keys", async () => {
    const result = await fetchProviderPages<string, string | number>({
      providerId: "garmin",
      stepName: "activities",
      initialCursor: 1,
      fetchPage: async (cursor) => {
        if (cursor === 1) {
          return { items: ["numeric-page"], nextCursor: "1" };
        }
        return { items: ["string-page"], nextCursor: null };
      },
    });

    expect(result.items).toEqual(["numeric-page", "string-page"]);
    expect(result.degradations).toEqual([]);
    expect(result.completed).toBe(true);
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
    expect(result.pagesFetched).toBe(1);
    expect(result.finalCursor).toBe("page-2");
    expect(result.completed).toBe(true);
    expect(result.stoppedByProviderRule).toBe(true);
  });

  it("processes fetched pages before a later page fetch fails", async () => {
    const processedItems: string[] = [];
    let calls = 0;

    await expect(
      fetchProviderPages<string, number>({
        providerId: "komoot",
        stepName: "activity_list",
        initialCursor: 0,
        fetchPage: async (cursor) => {
          calls += 1;
          if (cursor === 1) {
            throw new Error("later page failed");
          }

          return {
            items: ["tour-1"],
            nextCursor: 1,
          };
        },
        onPage: async (page) => {
          processedItems.push(...page.items);
        },
      }),
    ).rejects.toThrow("later page failed");

    expect(calls).toBe(2);
    expect(processedItems).toEqual(["tour-1"]);
  });

  it("passes accumulated items to onPage across pages", async () => {
    const seenAccumulatedItems: string[][] = [];

    await fetchProviderPages<string, number>({
      providerId: "komoot",
      stepName: "activity_list",
      initialCursor: 0,
      fetchPage: async (cursor) => {
        const currentCursor = cursor ?? 0;
        return currentCursor === 0
          ? { items: ["tour-1"], nextCursor: 1 }
          : { items: ["tour-2"], nextCursor: null };
      },
      onPage: async (_page, allItems) => {
        seenAccumulatedItems.push([...allItems]);
      },
    });

    expect(seenAccumulatedItems).toEqual([["tour-1"], ["tour-1", "tour-2"]]);
  });
});
