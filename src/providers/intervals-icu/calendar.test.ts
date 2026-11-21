import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  buildCalendarQueryWindows,
  fetchPlannedWorkouts,
  strictLocalEnvelope,
  toPlannedWorkoutEvents,
} from "./calendar.ts";
import { IntervalsIcuClient } from "./client.ts";

const EVENTS_URL = "https://intervals.icu/api/v1/athlete/0/events";
const server = setupServer();
// MSW patches global fetch on listen, so build the client afterwards.
let client: IntervalsIcuClient;

const event = (id: number, day: string, extra: Record<string, unknown> = {}) => ({
  id,
  category: "WORKOUT" as const,
  start_date_local: `${day}T06:30:00`,
  name: `Session ${id}`,
  ...extra,
});

beforeAll(() => {
  server.listen({ onUnhandledFrame: "error" });
  client = new IntervalsIcuClient("test-token", fetch);
});
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

function captureRequests(eventsByOldest: Record<string, unknown[]>) {
  const seen: Array<{ oldest: string | null; newest: string | null; url: URL }> = [];
  server.use(
    http.get(EVENTS_URL, ({ request }) => {
      const url = new URL(request.url);
      seen.push({
        oldest: url.searchParams.get("oldest"),
        newest: url.searchParams.get("newest"),
        url,
      });
      const key = url.searchParams.get("oldest") ?? "";
      return HttpResponse.json(eventsByOldest[key] ?? []);
    }),
  );
  return seen;
}

describe("strictLocalEnvelope", () => {
  it("returns the exact source-local window unchanged", () => {
    expect(strictLocalEnvelope("2026-03-01", "2026-06-29")).toEqual({
      from: "2026-03-01",
      to: "2026-06-29",
    });
  });

  it.each([
    ["reversed", "2026-06-01", "2026-03-01"],
    ["malformed", "2026-02-30", "2026-03-01"],
    ["not a date", "yesterday", "2026-03-01"],
  ])("rejects a %s window", (_name, from, to) => {
    expect(() => strictLocalEnvelope(from, to)).toThrow();
  });
});

describe("buildCalendarQueryWindows", () => {
  it("uses one exact query covering the window when it fits one chunk", () => {
    const windows = buildCalendarQueryWindows(
      { from: "2026-03-01", to: "2026-03-31" },
      { chunkDays: 365 },
    );
    expect(windows).toEqual([{ oldest: "2026-03-01", newest: "2026-03-31" }]);
  });

  it("splits a long window into disjoint exact chunks with no overlap or padding", () => {
    const windows = buildCalendarQueryWindows(
      { from: "2026-03-01", to: "2026-06-29" },
      { chunkDays: 30 },
    );
    expect(windows).toEqual([
      { oldest: "2026-03-01", newest: "2026-03-30" },
      { oldest: "2026-03-31", newest: "2026-04-29" },
      { oldest: "2026-04-30", newest: "2026-05-29" },
      { oldest: "2026-05-30", newest: "2026-06-28" },
      { oldest: "2026-06-29", newest: "2026-06-29" },
    ]);
  });

  it("never emits an empty or reversed chunk for a single-day window", () => {
    expect(
      buildCalendarQueryWindows({ from: "2026-03-08", to: "2026-03-08" }, { chunkDays: 365 }),
    ).toEqual([{ oldest: "2026-03-08", newest: "2026-03-08" }]);
  });
});

describe("fetchPlannedWorkouts", () => {
  it("requests only WORKOUT events with exact local date bounds and no resolve/ext/limit", async () => {
    const seen = captureRequests({ "2026-03-01": [event(1, "2026-03-10")] });
    const result = await fetchPlannedWorkouts(client, {
      strict: { from: "2026-03-01", to: "2026-03-31" },
      chunkDays: 365,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.oldest).toBe("2026-03-01");
    expect(seen[0]?.newest).toBe("2026-03-31");
    expect(seen[0]?.url.searchParams.get("category")).toBe("WORKOUT");
    expect(seen[0]?.url.searchParams.has("resolve")).toBe(false);
    expect(seen[0]?.url.searchParams.has("ext")).toBe(false);
    expect(seen[0]?.url.searchParams.has("limit")).toBe(false);
    expect(result.window).toEqual({ from: "2026-03-01", to: "2026-03-31" });
    expect(result.events).toHaveLength(1);
  });

  it("excludes coach-hidden events before they can enter the athlete snapshot", async () => {
    captureRequests({
      "2026-03-01": [event(1, "2026-03-10"), event(2, "2026-03-11", { hide_from_athlete: true })],
    });
    const result = await fetchPlannedWorkouts(client, {
      strict: { from: "2026-03-01", to: "2026-03-31" },
      chunkDays: 365,
    });
    expect(result.events.map((item) => item.id)).toEqual([1]);
  });

  it("filters an adjacent chunk's records using its start-day bounds", async () => {
    captureRequests({
      "2026-03-01": [event(1, "2026-03-10")],
      "2026-03-31": [event(1, "2026-03-10")],
    });
    const result = await fetchPlannedWorkouts(client, {
      strict: { from: "2026-03-01", to: "2026-06-29" },
      chunkDays: 30,
    });
    expect(result.events.filter((item) => item.id === 1)).toHaveLength(1);
  });

  it("drops an out-of-window record that overlaps the window", async () => {
    const overlapping = event(7, "2026-02-27", {
      end_date_local: "2026-03-02T00:00:00",
      workout_doc: { steps: [{ duration: 600 }] },
    });
    captureRequests({ "2026-03-01": [overlapping] });
    const result = await fetchPlannedWorkouts(client, {
      strict: { from: "2026-03-01", to: "2026-03-31" },
      chunkDays: 365,
    });
    expect(result.events).toEqual([]);
  });

  it("rejects conflicting duplicate ids instead of silently taking the first", async () => {
    captureRequests({
      "2026-03-01": [event(1, "2026-03-10"), event(1, "2026-03-10", { name: "Different" })],
    });
    await expect(
      fetchPlannedWorkouts(client, {
        strict: { from: "2026-03-01", to: "2026-03-31" },
        chunkDays: 365,
      }),
    ).rejects.toThrow(/Conflicting planned workout events/);
  });

  it("throws before returning any partial snapshot when a later chunk is malformed", async () => {
    server.use(
      http.get(EVENTS_URL, ({ request }) => {
        const oldest = new URL(request.url).searchParams.get("oldest");
        return HttpResponse.json(
          oldest === "2026-03-01" ? [event(1, "2026-03-10")] : { events: [] },
        );
      }),
    );
    await expect(
      fetchPlannedWorkouts(client, {
        strict: { from: "2026-03-01", to: "2026-06-29" },
        chunkDays: 30,
      }),
    ).rejects.toThrow();
  });

  it("throws when an event has no usable identity", async () => {
    captureRequests({
      "2026-03-01": [{ category: "WORKOUT", start_date_local: "2026-03-10T06:30:00" }],
    });
    await expect(
      fetchPlannedWorkouts(client, {
        strict: { from: "2026-03-01", to: "2026-03-31" },
        chunkDays: 365,
      }),
    ).rejects.toThrow();
  });

  it("rejects an impossible calendar date that falls lexically inside the window", async () => {
    // 2026-02-30 is shaped like a valid day and sorts inside this window, so
    // only the z.iso.date check at the vendor boundary can discard it.
    captureRequests({ "2026-02-01": [event(1, "2026-02-30")] });
    await expect(
      fetchPlannedWorkouts(client, {
        strict: { from: "2026-02-01", to: "2026-03-31" },
        chunkDays: 365,
      }),
    ).rejects.toThrow();
  });

  it("honors an aborted signal", async () => {
    const controller = new AbortController();
    controller.abort();
    captureRequests({ "2026-03-01": [event(1, "2026-03-10")] });
    await expect(
      fetchPlannedWorkouts(client, {
        strict: { from: "2026-03-01", to: "2026-03-31" },
        chunkDays: 365,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });
});

describe("toPlannedWorkoutEvents", () => {
  it("maps vendor fields to validated neutral events without interpreting the workout document", () => {
    const workoutDoc = { steps: [{ duration: 600, power: { start: 35, end: 55, units: "%ftp" } }] };
    const raw = [
      event(1, "2026-03-10", {
        name: "Ramp",
        description: "notes",
        type: "Ride",
        workout_doc: workoutDoc,
      }),
      event(2, "2026-03-11", { start_date_local: "2026-03-11" }),
    ];
    expect(toPlannedWorkoutEvents(raw)).toEqual([
      {
        externalId: "1",
        startDate: "2026-03-10",
        startTime: "06:30:00",
        title: "Ramp",
        description: "notes",
        sportType: "Ride",
        workoutDoc,
      },
      {
        externalId: "2",
        startDate: "2026-03-11",
        startTime: null,
        title: "Session 2",
        description: null,
        sportType: null,
        workoutDoc: null,
      },
    ]);
  });

  it("treats exact midnight as no authored time but keeps a real 07:00 and the calendar day", () => {
    const raw = [
      // Documented date-only WORKOUT format ends in T00:00:00:
      // https://forum.intervals.icu/t/api-access-to-intervals-icu/609/4
      event(3, "2026-03-12", { start_date_local: "2026-03-12T00:00:00" }),
      event(4, "2026-03-13", { start_date_local: "2026-03-13T00:00" }),
      event(5, "2026-03-14", { start_date_local: "2026-03-14T07:00:00" }),
    ];
    expect(toPlannedWorkoutEvents(raw)).toMatchObject([
      { externalId: "3", startDate: "2026-03-12", startTime: null },
      { externalId: "4", startDate: "2026-03-13", startTime: null },
      { externalId: "5", startDate: "2026-03-14", startTime: "07:00:00" },
    ]);
  });
});
