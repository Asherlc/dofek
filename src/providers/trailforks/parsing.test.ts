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

  it("maps string sport labels and ignores blank titles", () => {
    const parsed = parseTrailforksActivityListResult(
      structuredResult({
        activities: [
          {
            id: 3,
            title: "   ",
            name: "  Named ride  ",
            started_at: "2026-09-19T16:30:00Z",
            sport: "hiking",
          },
        ],
      }),
    );

    expect(parsed[0]).toMatchObject({
      externalId: "3",
      name: "Named ride",
      // String sports keep the upstream label as providerType; canonical falls back to other.
      activityType: { canonicalType: "other", modality: null, providerType: "hiking" },
    });
  });

  it("rejects non-record rows, inverted ends, and non-object list envelopes", () => {
    expect(() =>
      parseTrailforksActivityListResult(structuredResult({ activities: [null] })),
    ).toThrow(TrailforksActivityParseError);
    expect(() =>
      parseTrailforksActivityListResult(
        structuredResult({
          activities: [
            {
              id: 1,
              started_at: "2026-09-19T18:00:00Z",
              ended_at: "2026-09-19T17:00:00Z",
            },
          ],
        }),
      ),
    ).toThrow(TrailforksActivityParseError);
    expect(() =>
      parseTrailforksActivityListResult(structuredResult({ activities: "nope" })),
    ).toThrow(TrailforksActivityParseError);
    expect(() => parseTrailforksActivityListResult(structuredResult({}))).toThrow(
      TrailforksActivityParseError,
    );
  });

  it("rejects invalid text payloads and non-text content blocks", () => {
    expect(() =>
      parseTrailforksActivityListResult({
        content: [{ type: "text", text: "not-json" }],
      }),
    ).toThrow(TrailforksActivityParseError);
    expect(() =>
      parseTrailforksActivityListResult({
        content: [
          { type: "text", text: "[]" },
          { type: "text", text: "[]" },
        ],
      }),
    ).toThrow(TrailforksActivityParseError);
    expect(() =>
      parseTrailforksActivityListResult({
        content: [{ type: "image", data: "abc", mimeType: "image/png" }],
      }),
    ).toThrow(TrailforksActivityParseError);
  });

  it("accepts non-www ridelog URLs with optional slash and query/hash", () => {
    const parsed = parseTrailforksActivityListResult(
      structuredResult({
        activities: [
          {
            link: "https://trailforks.com/ridelog/view/77881?x=1#y",
            started_at: "2026-01-02T10:00:00+00:00",
          },
        ],
      }),
    );
    expect(parsed[0]?.externalId).toBe("77881");
  });

  it("rejects prefixed or non-https ridelog URLs and non-digit ids in the path", () => {
    for (const link of [
      "prefixhttps://www.trailforks.com/ridelog/view/1/",
      "http://www.trailforks.com/ridelog/view/1/",
      "https://www.trailforks.com/ridelog/view/12abc/",
      "https://www.trailforks.com/ridelog/view/",
      "https://evil.example/https://www.trailforks.com/ridelog/view/1/",
    ]) {
      expect(() =>
        parseTrailforksActivityListResult(
          structuredResult({
            activities: [{ link, started_at: "2026-01-02T10:00:00+00:00" }],
          }),
        ),
      ).toThrow(TrailforksActivityParseError);
    }
  });

  it("ignores non-finite numeric fields when reading activity types", () => {
    const parsed = parseTrailforksActivityListResult(
      structuredResult({
        activities: [
          {
            id: 8,
            started_at: "2026-09-19T16:30:00Z",
            activitytype: Number.NaN,
            sport: "running",
          },
        ],
      }),
    );
    expect(parsed[0]?.activityType).toMatchObject({
      canonicalType: "other",
      providerType: "running",
    });
  });

  it("accepts equal start and end timestamps", () => {
    const parsed = parseTrailforksActivityListResult(
      structuredResult({
        activities: [
          {
            id: 4,
            started_at: "2026-09-19T16:30:00Z",
            ended_at: "2026-09-19T16:30:00Z",
          },
        ],
      }),
    );
    expect(parsed[0]?.endedAt).toEqual(new Date("2026-09-19T16:30:00Z"));
  });

  it("does not treat non-integer numeric activity types as mapped sports", () => {
    const parsed = parseTrailforksActivityListResult(
      structuredResult({
        activities: [
          {
            id: 5,
            started_at: "2026-09-19T16:30:00Z",
            activitytype: 1.5,
          },
        ],
      }),
    );
    expect(parsed[0]).not.toHaveProperty("activityType");
  });

  it("rejects array and null structured payloads that are not activity lists", () => {
    expect(() =>
      parseTrailforksActivityListResult({
        content: [],
        structuredContent: null,
      }),
    ).toThrow(TrailforksActivityParseError);
    expect(() =>
      parseTrailforksActivityListResult({
        content: [{ type: "text", text: '{"activities":null}' }],
      }),
    ).toThrow(TrailforksActivityParseError);
  });

  it("prefers structuredContent over text and ignores non-text content blocks", () => {
    const parsedFromStructured = parseTrailforksActivityListResult({
      content: [{ type: "text", text: "not-used" }],
      structuredContent: { activities: [SYNTHETIC_ACTIVITY] },
    });
    expect(parsedFromStructured[0]?.externalId).toBe("42001");

    const parsedFromText = parseTrailforksActivityListResult({
      content: [
        { type: "image", data: "abc", mimeType: "image/png" },
        { type: "text", text: JSON.stringify([SYNTHETIC_ACTIVITY]) },
      ],
    });
    expect(parsedFromText[0]?.externalId).toBe("42001");
  });

  it("maps every documented numeric activitytype used by the provider", () => {
    for (const id of [1, 2, 5, 6, 10, 11, 12, 13, 17, 18, 19] as const) {
      expect(mapTrailforksActivityType(id).canonicalType).not.toBe("other");
      expect(mapTrailforksActivityType(id).providerType).toBe(String(id));
    }
    expect(mapTrailforksActivityType(12)).toEqual({
      canonicalType: "skiing",
      modality: null,
      providerType: "12",
    });
    expect(mapTrailforksActivityType(17).canonicalType).toBe("cycling");
    expect(mapTrailforksActivityType(18).canonicalType).toBe("cycling");
  });
});
