import type { CallToolResult } from "@modelcontextprotocol/client";
import { describe, expect, it } from "vitest";
import {
  mapTrailforksActivityType,
  parseTrailforksActivityListResult,
  TrailforksActivityParseError,
} from "./parsing.ts";

/** Synthetic fixture — not an observed Trailforks MCP payload. */
const SYNTHETIC_ACTIVITY = {
  id: 42_001,
  title: "Synthetic Squamish loop",
  started_at: "2026-09-19T16:30:00-07:00",
  activitytype: 1,
  link: "https://www.trailforks.com/ridelog/view/42001/",
} as const;

function structuredResult(value: Record<string, unknown>): CallToolResult {
  return { content: [], structuredContent: value };
}

function textResult(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

describe("mapTrailforksActivityType", () => {
  it.each([
    [1, "cycling", "mountain"],
    [2, "cycling", "electric"],
    [19, "cycling", "gravel"],
    [5, "running", "trail"],
    [6, "hiking", null],
    [10, "snowshoeing", null],
    [11, "skiing", "downhill"],
    [13, "skiing", "cross_country"],
    [99, "other", null],
  ] as const)("maps activitytype %s to canonical %s / modality %s", (id, canonical, modality) => {
    expect(mapTrailforksActivityType(id)).toEqual({
      canonicalType: canonical,
      modality,
      providerType: String(id),
    });
  });
});

describe("parseTrailforksActivityListResult", () => {
  it("accepts a structured activities object and preserves unmodified raw rows", () => {
    const parsed = parseTrailforksActivityListResult(
      structuredResult({ activities: [SYNTHETIC_ACTIVITY] }),
    );

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      externalId: "42001",
      name: "Synthetic Squamish loop",
      startedAt: new Date("2026-09-19T16:30:00-07:00"),
      activityType: {
        canonicalType: "cycling",
        modality: "mountain",
        providerType: "1",
      },
    });
    expect(parsed[0]).not.toHaveProperty("endedAt");
    expect(parsed[0]?.raw).toEqual(SYNTHETIC_ACTIVITY);
  });

  it("accepts a top-level activities array via a single JSON text block", () => {
    const fromText = parseTrailforksActivityListResult(textResult([SYNTHETIC_ACTIVITY]));

    expect(fromText[0]?.externalId).toBe("42001");
  });

  it("accepts ridelog_id / Unix start_timestamp and explicit reliable ends only", () => {
    const parsed = parseTrailforksActivityListResult(
      structuredResult({
        activities: [
          {
            ridelog_id: 99,
            start_timestamp: 1_721_000_000,
            ended_at: "2024-07-16T18:20:00Z",
            activitytype: 6,
          },
        ],
      }),
    );

    expect(parsed[0]).toMatchObject({
      externalId: "99",
      startedAt: new Date(1_721_000_000 * 1000),
      endedAt: new Date("2024-07-16T18:20:00Z"),
    });
    expect(parsed[0]).not.toHaveProperty("name");
  });

  it("rejects Unix timestamps that overflow Date range", () => {
    expect(() =>
      parseTrailforksActivityListResult(
        structuredResult({
          activities: [
            {
              id: 1,
              // Beyond Date's ±100,000,000 day range once converted to ms.
              start_timestamp: 9e15,
            },
          ],
        }),
      ),
    ).toThrow(TrailforksActivityParseError);
  });

  it("derives identity from a canonical Trailforks ridelog/view URL when ids are absent", () => {
    const parsed = parseTrailforksActivityListResult(
      structuredResult({
        activities: [
          {
            link: "https://www.trailforks.com/ridelog/view/7788/",
            started_at: "2026-01-02T10:00:00+00:00",
          },
        ],
      }),
    );

    expect(parsed[0]?.externalId).toBe("7788");
    expect(parsed[0]).not.toHaveProperty("activityType");
    expect(parsed[0]).not.toHaveProperty("name");
    expect(parsed[0]).not.toHaveProperty("endedAt");
  });

  it("rejects the whole payload when any row is malformed", () => {
    expect(() =>
      parseTrailforksActivityListResult(
        structuredResult({
          activities: [
            SYNTHETIC_ACTIVITY,
            { id: 2, started_at: "2026-09-19" }, // date-only — not allowed
          ],
        }),
      ),
    ).toThrow(TrailforksActivityParseError);
  });

  it.each([
    ["date-only start", { id: 1, started_at: "2026-09-19" }],
    ["start without an offset", { id: 1, started_at: "2026-09-19T16:30:00" }],
    ["missing identity", { started_at: "2026-09-19T16:30:00Z" }],
    ["non-positive id", { id: 0, started_at: "2026-09-19T16:30:00Z" }],
    [
      "legacy ridelog URL without /view/",
      { link: "https://www.trailforks.com/ridelog/7788/", started_at: "2026-01-02T10:00:00+00:00" },
    ],
  ])("rejects %s", (_case, row) => {
    expect(() =>
      parseTrailforksActivityListResult(structuredResult({ activities: [row] })),
    ).toThrow(TrailforksActivityParseError);
  });

  it("does not invent an end time from elapsed or moving duration fields", () => {
    const parsed = parseTrailforksActivityListResult(
      structuredResult({
        activities: [
          {
            id: 7,
            started_at: "2026-09-19T16:30:00Z",
            moving_time: 3600,
            elapsed_time: 4000,
          },
        ],
      }),
    );

    expect(parsed[0]).not.toHaveProperty("endedAt");
  });

  it("accepts an empty activities list", () => {
    expect(parseTrailforksActivityListResult(structuredResult({ activities: [] }))).toEqual([]);
  });
});
