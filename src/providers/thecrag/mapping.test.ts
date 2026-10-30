import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { mapTheCragAscent } from "./mapping.ts";
import { apiAscent, gradeCases } from "./test-helpers.ts";

describe("theCrag official ascent mapping", () => {
  it("retains stable IDs, recorded date, private notes and raw provenance", () => {
    const ascent = apiAscent();
    expect(mapTheCragAscent(ascent, "123")).toMatchObject({
      externalId: "thecrag:1001",
      climbedOn: "2026-10-10",
      notes: "Private training notes",
      raw: { accountId: "123", ascent },
      climb: {
        externalId: "2001",
        name: "Sample route",
        kind: "route",
        publishedGrades: [{ system: "yds", value: "5.10b" }],
      },
      attempts: [{ scope: "climb", ropeMethod: "top_rope", sourceResult: "attempt" }],
    });
  });

  it.each(gradeCases)("maps explicit grade %s", (grade, style, gear, system, value) => {
    const record = mapTheCragAscent(
      apiAscent({
        climbedGearStyle: gear,
        tick: { label: "attempt", name: "Attempt" },
        route: { id: "2001", style, grade },
      }),
      "123",
    );
    expect(record.climb?.publishedGrades).toEqual([{ system, value }]);
  });

  it("preserves absent methods rather than inferring lead from sport", () => {
    const record = mapTheCragAscent(
      apiAscent({
        climbedGearStyle: "sport",
        tick: { label: "redpoint" },
        route: { id: "2001", style: "Sport" },
      }),
      "123",
    );
    expect(record.attempts).toEqual([
      expect.objectContaining({ sourceResult: "redpoint", qualifier: "free-send" }),
    ]);
    expect(record.attempts[0]?.ropeMethod).toBeUndefined();
    expect(record.reportedAttemptCounts).toBeUndefined();
  });

  it("keeps unknown tick labels and opaque pitch data without inventing pitch identities", () => {
    const record = mapTheCragAscent(
      apiAscent({
        climbedGearStyle: null,
        tick: { label: "custom-result" },
        pitch: [{ undocumented: true }],
        route: { id: "2001" },
      }),
      "123",
    );
    expect(record.attempts).toEqual([{ scope: "climb", sourceResult: "custom-result" }]);
    expect(record.climb?.pitches).toBeUndefined();
    expect(record.raw).toMatchObject({ ascent: { pitch: [{ undocumented: true }] } });
  });

  it.each(["Redpoint: Top rope", "redpoint: top rope"])(
    "separates result and method in %s",
    (name) => {
      const record = mapTheCragAscent(apiAscent({ tick: { label: "redpoint", name } }), "123");
      expect(record.attempts[0]).toMatchObject({
        sourceResult: "redpoint",
        ropeMethod: "top_rope",
        qualifier: "free-send",
      });
    },
  );

  it("keeps an explicit empty note as a source update", () => {
    expect(mapTheCragAscent(apiAscent({ markdown: "" }), "123").notes).toBeNull();
    expect(
      mapTheCragAscent(JSON.parse(JSON.stringify(apiAscent({ markdown: undefined }))), "123").notes,
    ).toBeUndefined();
  });

  it.each(["2026-00-00", "2026-02-30", "2026-10-10junk"])(
    "rejects incomplete/invalid date %s",
    (date) => {
      expect(() => mapTheCragAscent(apiAscent({ date }), "123")).toThrow(/climb date/);
    },
  );

  it("sanitizes schema failures containing private notes", () => {
    let failure: unknown;
    try {
      mapTheCragAscent(
        apiAscent({ id: "private-key", markdown: { secret: "private notes" } }),
        "123",
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(inspect(failure, { depth: null })).not.toMatch(/private-key|private notes/);
  });
});

it("maps documented ancestor identities in depth order without duplicating the parent crag", () => {
  const record = mapTheCragAscent(
    apiAscent({
      route: {
        id: "2001",
        style: "Sport",
        ancestors: {
          parent: { id: "30", name: "Crag", depth: 3 },
          country: { id: "10", name: "Country", depth: 1 },
          TLC: { id: "30", name: "Crag", depth: 3 },
        },
      },
    }),
    "123",
  );
  expect(record.climb?.areas).toEqual([
    { externalId: "10", name: "Country" },
    { externalId: "30", name: "Crag" },
  ]);
});

it.each([null, undefined, ""])(
  "preserves an unavailable source date (%j) rather than clearing an existing date",
  (date) => {
    const source = JSON.parse(JSON.stringify(apiAscent({ date })));
    expect(mapTheCragAscent(source, "123").climbedOn).toBeUndefined();
  },
);
