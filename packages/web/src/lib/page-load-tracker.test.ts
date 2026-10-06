import { describe, expect, it } from "vitest";
import { type PageLoadEvent, PageLoadTracker } from "./page-load-tracker.ts";

describe("PageLoadTracker", () => {
  it("waits for every required section in the current generation", () => {
    const events: PageLoadEvent[] = [];
    const tracker = new PageLoadTracker((event) => events.push(event));
    const generation = tracker.begin({
      route: "/",
      kind: "navigation",
      startedAt: 100,
      sections: ["cards", "chart"],
    });
    tracker.report({ generation, section: "cards", status: "ready", completedAt: 200 });
    expect(events.filter((event) => event.section === undefined)).toEqual([]);
    tracker.report({ generation, section: "chart", status: "ready", completedAt: 450 });
    tracker.report({ generation, section: "chart", status: "ready", completedAt: 500 });
    expect(events.filter((event) => event.section === undefined)).toEqual([
      expect.objectContaining({ generation, outcome: "ready", durationMs: 350 }),
    ]);
    expect(events.filter((event) => event.section === "chart")).toHaveLength(1);
  });

  it("ignores old results and undeclared sections after a new filter generation", () => {
    const events: PageLoadEvent[] = [];
    const tracker = new PageLoadTracker((event) => events.push(event));
    const old = tracker.begin({
      route: "/body/heart-rate",
      kind: "navigation",
      startedAt: 100,
      sections: ["chart"],
    });
    const generation = tracker.begin({
      route: "/body/heart-rate",
      kind: "filter",
      startedAt: 200,
      sections: ["chart"],
    });
    tracker.report({ generation: old, section: "chart", status: "ready", completedAt: 250 });
    tracker.report({ generation, section: "other", status: "ready", completedAt: 260 });
    expect(events.map((event) => event.outcome)).toEqual(["cancelled"]);
    tracker.report({ generation, section: "chart", status: "ready", completedAt: 400 });
    expect(events.at(-1)).toMatchObject({ kind: "filter", durationMs: 200 });
  });

  it.each(["error", "cancelled"] as const)("never completes %s as ready", (outcome) => {
    const events: PageLoadEvent[] = [];
    const tracker = new PageLoadTracker((event) => events.push(event));
    const generation = tracker.begin({
      route: "/dashboard",
      kind: "navigation",
      startedAt: 100,
      sections: ["cards", "chart"],
    });
    if (outcome === "error")
      tracker.report({ generation, section: "cards", status: "error", completedAt: 200 });
    else tracker.cancel(generation, 200);
    tracker.report({ generation, section: "chart", status: "ready", completedAt: 300 });
    tracker.report({ generation, section: "cards", status: "ready", completedAt: 400 });
    expect(events.filter((event) => event.section === undefined)).toEqual([
      expect.objectContaining({ outcome, durationMs: 100 }),
    ]);
  });

  it.each([
    { first: "empty", second: "empty", outcome: "empty" },
    { first: "ready", second: "empty", outcome: "ready" },
  ] as const)("completes $first/$second as $outcome", ({ first, second, outcome }) => {
    const events: PageLoadEvent[] = [];
    const tracker = new PageLoadTracker((event) => events.push(event));
    const generation = tracker.begin({
      route: "/dashboard",
      kind: "navigation",
      startedAt: 100,
      sections: ["cards", "chart"],
    });
    tracker.report({ generation, section: "cards", status: first, completedAt: 200 });
    tracker.report({ generation, section: "chart", status: second, completedAt: 450 });
    expect(events.at(-1)).toMatchObject({ outcome, durationMs: 350 });
  });
});
