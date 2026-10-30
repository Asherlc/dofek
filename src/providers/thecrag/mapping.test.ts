import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { mapTheCragAscent } from "./mapping.ts";
import { apiAscent, gradeCases } from "./test-helpers.ts";

describe("theCrag official ascent mapping", () => {
  it.each([
    [" LEAD ", "lead"],
    ["lead solo", "lead"],
    ["top-rope", "top_rope"],
    ["top rope solo", "top_rope"],
    ["free solo", "unroped"],
    ["solo", "unroped"],
    ["unroped", "unroped"],
    ["follow", "follow"],
    ["second", "follow"],
  ])("maps recorded method %s", (gear, ropeMethod) => {
    const record = mapTheCragAscent(
      apiAscent({ climbedGearStyle: gear, tick: null, route: { id: "2001" } }),
      "123",
    );
    expect(record.attempts).toEqual([
      { scope: "climb", ropeMethod, ...(gear.includes("solo") ? { solo: true } : {}) },
    ]);
    expect(record.climb?.kind).toBe("route");
  });

  it.each(["xlead", "leadx", "xfollow", "followx", "xsolo", "solox", "xtop rope", "top ropex"])(
    "preserves unknown method %s",
    (gear) => {
      expect(
        mapTheCragAscent(
          apiAscent({ climbedGearStyle: gear, tick: null, route: { id: "2001" } }),
          "123",
        ).attempts[0]?.ropeMethod,
      ).toBeUndefined();
    },
  );

  it.each([
    ["onsight", "free-onsight"],
    ["on sight", "free-onsight"],
    ["flash", "free-flash"],
    ["aid onsight", "aid-onsight"],
    ["aid flash", "aid-flash"],
    ["clean", "free-send"],
    ["send", "free-send"],
    ["greenpoint", "free-send"],
    ["fell/hung", "fell-hung"],
    ["dab", "dab"],
  ])("maps source qualifier %s", (label, qualifier) => {
    expect(
      mapTheCragAscent(apiAscent({ tick: { label: ` ${label.toUpperCase()} ` } }), "123")
        .attempts[0],
    ).toMatchObject({ sourceResult: label.toUpperCase(), qualifier });
  });

  it.each([
    ["dog", { fellOrHung: true }],
    ["hang dog", { fellOrHung: true }],
    ["repeat", { hadCompletedBefore: true, qualifier: "free-send" }],
    ["pinkpoint", { usedPreplacedProtection: true, qualifier: "free-send" }],
    ["ground-up redpoint", { priorFailedAttemptsGroundUp: true, qualifier: "free-send" }],
    ["french free", { usedAid: true }],
    ["frenchfree", { usedAid: true }],
  ])("preserves source result facts for %s", (label, facts) => {
    expect(mapTheCragAscent(apiAscent({ tick: { label } }), "123").attempts).toEqual([
      { scope: "climb", ropeMethod: "top_rope", sourceResult: label, ...facts },
    ]);
  });

  it.each(["sport", "trad"])("preserves %s protection", (style) => {
    const record = mapTheCragAscent(
      apiAscent({
        climbedGearStyle: style,
        tick: null,
        route: { id: "2001", style: ` ${style.toUpperCase()} ` },
      }),
      "123",
    );
    expect(record.attempts).toEqual([{ scope: "climb", protectionUsed: [style] }]);
    expect(record.climb).toEqual({ externalId: "2001", kind: "route", routeProtection: [style] });
  });

  it("derives result and method from a tick name when the label is blank", () => {
    expect(
      mapTheCragAscent(
        apiAscent({ climbedGearStyle: null, tick: { label: " ", name: " Flash : Lead Solo " } }),
        "123",
      ).attempts,
    ).toEqual([
      {
        scope: "climb",
        sourceResult: "Flash",
        ropeMethod: "lead",
        solo: true,
        qualifier: "free-flash",
      },
    ]);
  });

  it.each([
    { climbedGearStyle: "boulder", route: { id: "2001", style: "Sport" } },
    { climbedGearStyle: "lead", tick: { name: "Flash: Top rope" } },
    { climbedGearStyle: "boulder", tick: { name: "Flash: Lead" }, route: { id: "2001" } },
  ])("rejects conflicting source facts %j", (facts) => {
    expect(() => mapTheCragAscent(apiAscent(facts), "123")).toThrow(/conflicting climbing/);
  });

  it("retains unknown discipline and absent optional facts", () => {
    const record = mapTheCragAscent({ id: 1, epoch: 0, route: { id: 2 } }, "123");
    expect(record).toEqual({
      externalId: "thecrag:1",
      sourceName: "theCrag",
      attempts: [{ scope: "climb" }],
      climb: { externalId: "2" },
      raw: { accountId: "123", ascent: { id: 1, epoch: 0, route: { id: 2 } } },
    });
  });

  it("preserves known boulder identity without inferring a rope method", () => {
    expect(
      mapTheCragAscent(
        apiAscent({
          climbedGearStyle: " BOULDER ",
          tick: null,
          route: { id: "2", name: "  ", grade: " V10 " },
        }),
        "123",
      ),
    ).toMatchObject({
      discipline: "rock_climbing",
      attempts: [{ scope: "climb" }],
      climb: {
        externalId: "2",
        kind: "boulder",
        name: null,
        publishedGrades: [{ system: "v_scale", value: "V10" }],
      },
    });
  });

  it("maps datetime dates and trims notes and route names", () => {
    expect(
      mapTheCragAscent(
        apiAscent({
          date: "2026-10-10T23:45:00+02:00",
          markdown: " note ",
          route: { id: "2", name: " Route " },
        }),
        "123",
      ),
    ).toMatchObject({ climbedOn: "2026-10-10", notes: "note", climb: { name: "Route" } });
  });

  it.each(["0000-01-01", "2026-10-10T25:00:00Z"])("rejects unusable day %s", (date) => {
    expect(() => mapTheCragAscent(apiAscent({ date }), "123")).toThrow(/climb date/);
  });

  it("retains aid use without assigning a free send", () => {
    expect(
      mapTheCragAscent(apiAscent({ climbedGearStyle: "aid", tick: { label: "redpoint" } }), "123")
        .attempts,
    ).toEqual([{ scope: "climb", sourceResult: "redpoint", usedAid: true }]);
  });

  it.each(["Vx", "5.invalid", "FR invalid", "Unknown grade"])(
    "preserves unrecognized grade %s",
    (grade) => {
      expect(
        mapTheCragAscent(apiAscent({ route: { id: "2", grade } }), "123").climb?.publishedGrades,
      ).toEqual([{ system: null, value: grade }]);
    },
  );

  it.each([
    ["boulder", "5.10a"],
    ["sport", "V4"],
  ])("rejects incompatible %s grade %s", (style, grade) => {
    expect(() =>
      mapTheCragAscent(
        apiAscent({ climbedGearStyle: style, tick: null, route: { id: "2", style, grade } }),
        "123",
      ),
    ).toThrow(/unsupported or ambiguous grade/);
  });

  it("maps compound explicit scales", () => {
    expect(
      mapTheCragAscent(apiAscent({ route: { id: "2", grade: "FR 6a YDS 5.10a" } }), "123").climb
        ?.publishedGrades,
    ).toEqual([
      { system: "french", value: "6a" },
      { system: "yds", value: "5.10a" },
    ]);
  });

  it("rejects non-JSON provenance without exposing it", () => {
    expect(() => mapTheCragAscent(apiAscent({ secret: () => "private notes" }), "123")).toThrow(
      /invalid ascent provenance/,
    );
  });
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
