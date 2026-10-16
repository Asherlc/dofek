import { expect, it } from "vitest";
import {
  LegacyClimbingFactConflict,
  type LegacyClimbingRow,
  legacyClimbingDefinition,
} from "./climbing-log-legacy-source.ts";

function row(overrides: Partial<LegacyClimbingRow> = {}): LegacyClimbingRow {
  return {
    id: "log",
    user_id: "owner",
    provider_id: "openbeta",
    external_id: "source-log",
    activity_id: null,
    activity_external_id: null,
    unattached_date: null,
    climb_type: "route",
    grade: "5.10a",
    grade_system: "yds",
    result_style: null,
    legacy_climb_style: null,
    route_name: "Corner",
    route_protection: null,
    location_path: [],
    raw: null,
    model_converted: false,
    attempt_count: null,
    ...overrides,
  };
}
it("recovers verified KAYA identities and source calendar dates without using the activity date", () => {
  const definition = legacyClimbingDefinition(
    row({
      provider_id: "kaya",
      activity_id: "activity",
      activity_external_id: "session-1",
      raw: {
        id: 12,
        date: "2026-10-01T23:50:00-07:00",
        attempts: 3,
        ascent_type: { name: "Flash" },
        climb: { id: 42, grade: { name: "5.10a" }, lead: true },
      },
    }),
    false,
  );
  expect(definition).toMatchObject({
    externalId: "kaya:ascent:12",
    climbedOn: "2026-10-01",
    recordedCount: 3,
    climb: { externalId: "42" },
    facts: { outcome: "completed", ropeMethod: "lead", receivedBeta: true, attemptIndex: 1 },
  });
  const attempted = legacyClimbingDefinition(
    row({
      provider_id: "kaya",
      activity_id: "activity",
      activity_external_id: "session-1",
      result_style: "Attempt",
      raw: { id: "session-1_42", attempts: 2, climb_type: { name: "Route" } },
    }),
    false,
  );
  expect(attempted).toMatchObject({
    externalId: "kaya:session:session-1:attempted:session-1_42",
    climb: { externalId: "42" },
    climbedOn: null,
    recordedCount: 2,
  });
});
it("preserves MP catalogue versus reported grades and independent aid/solo facts", () => {
  const definition = legacyClimbingDefinition(
    row({
      provider_id: "mountain-project",
      legacy_climb_style: "solo",
      result_style: "Flash",
      raw: {
        URL: "https://www.mountainproject.com/route/123/corner",
        Rating: "5.10a",
        "Your Rating": "5.10b",
        Notes: "Source note",
        Date: "2026-10-01",
      },
    }),
    false,
  );
  expect(definition).toMatchObject({
    climb: {
      externalId: "123",
      publishedGrades: [{ value: "5.10a", system: "yds" }],
      setting: null,
    },
    reportedGrades: [{ value: "5.10b", system: "yds" }],
    facts: { solo: true, usedAid: false, receivedBeta: true },
    notes: "Source note",
  });
  const aid = legacyClimbingDefinition(
    row({
      provider_id: "mountain-project",
      legacy_climb_style: "aid",
      result_style: "Flash",
      raw: { URL: "https://www.mountainproject.com/route/123/corner", Rating: "5.10a" },
    }),
    false,
  );
  expect(aid.facts).toMatchObject({ outcome: "completed", usedAid: true });
  expect(aid.facts.fellOrHung).toBeUndefined();
});
it("recovers KAYA attempted target identity and retained session gym evidence", () => {
  const definition = legacyClimbingDefinition(
    row({
      provider_id: "kaya",
      activity_id: "activity",
      activity_external_id: "1000",
      result_style: "Attempt",
      location_path: [{ name: "Recorded gym", externalId: "gym-1", kind: "gym" }],
      raw: { id: "1000_2001", attempts: 2, climb_type: { name: "Route" }, gym: null },
    }),
    false,
  );
  expect(definition).toMatchObject({
    externalId: "kaya:session:1000:attempted:1000_2001",
    climb: { externalId: "2001", setting: "indoor" },
    recordedCount: 2,
  });
  expect(() =>
    legacyClimbingDefinition(
      row({
        provider_id: "kaya",
        activity_id: "activity",
        activity_external_id: "1000",
        raw: { id: "9999_2001" },
      }),
      false,
    ),
  ).toThrow("identity");
});
it("recovers independently known OpenBeta methods and aid from retained source fields", () => {
  const source = {
    climb: { uuid: "route", grades: { yds: "5.10a" } },
    style: "TR",
    attemptType: "Fell/Hung",
  };
  expect(legacyClimbingDefinition(row({ raw: source }), false).facts).toMatchObject({
    ropeMethod: "top_rope",
    fellOrHung: true,
  });
  expect(
    legacyClimbingDefinition(
      row({ raw: { ...source, style: "Solo", attemptType: "FrenchFree" } }),
      false,
    ).facts,
  ).toMatchObject({ solo: true, usedAid: true });
});
it("retains theCrag independent gear, aid completion, repeat and fall/hang facts", () => {
  const aid = legacyClimbingDefinition(
    row({
      provider_id: "thecrag",
      raw: {
        ascent: {
          date: "2026-10-01",
          route: { id: "42" },
          climbedGearStyle: "Aid",
          tick: { label: "Aid solo" },
        },
      },
    }),
    false,
  );
  expect(aid).toMatchObject({
    climb: { externalId: "42" },
    climbedOn: "2026-10-01",
    facts: { solo: true, usedAid: true },
  });
  const repeat = legacyClimbingDefinition(
    row({
      provider_id: "thecrag",
      raw: { ascent: { route: { id: "42" }, climbedGearStyle: "Trad", tick: { label: "Repeat" } } },
    }),
    true,
  );
  expect(repeat.facts).toMatchObject({
    protectionUsed: ["trad"],
    hadCompletedBefore: true,
    outcome: "completed",
  });
  const hung = legacyClimbingDefinition(
    row({
      provider_id: "thecrag",
      raw: { ascent: { route: { id: "42" }, tick: { label: "Fell/Hung" } } },
    }),
    false,
  );
  expect(hung.facts).toMatchObject({ fellOrHung: true });
  expect(hung.facts.outcome).toBeUndefined();
});
it("keeps CSV row grades on the log and rejects contradictory stored source totals", () => {
  const definition = legacyClimbingDefinition(
    row({
      provider_id: "kaya-export",
      raw: { grade: "5.10a", gym: "Gym", ascentType: "Flash", attempts: 2, date: "2026-10-01" },
    }),
    false,
  );
  expect(definition).toMatchObject({
    climb: { externalId: null, publishedGrades: [], setting: "indoor" },
    reportedGrades: [{ value: "5.10a", system: "yds" }],
    recordedCount: 2,
  });
  expect(definition.facts.receivedBeta).toBeUndefined();
  expect(() =>
    legacyClimbingDefinition(
      row({ provider_id: "kaya-export", attempt_count: 2, raw: { attempts: 3 } }),
      false,
    ),
  ).toThrow("count");
});

it.each([0, "2", 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1])(
  "rejects a retained invalid KAYA count %s",
  (attempts) => {
    expect(() =>
      legacyClimbingDefinition(
        row({
          provider_id: "kaya",
          raw: { id: 12, climb: { id: 42 }, attempts },
        }),
        false,
      ),
    ).toThrow(expect.objectContaining({ field: "attemptCount" }));
  },
);
it("preserves valid source counts without applying another provider's count fields", () => {
  for (const count of [1, 2]) {
    expect(
      legacyClimbingDefinition(
        row({
          provider_id: "kaya",
          attempt_count: count,
          raw: { id: 12, climb: { id: 42 }, attempts: count },
        }),
        false,
      ).recordedCount,
    ).toBe(count);
  }
  expect(legacyClimbingDefinition(row({ raw: { attempts: 3 } }), false).recordedCount).toBeNull();
});
it.each([{ clean: false }, { ascent: { clean: false } }])(
  "rejects ambiguous legacy execution facts %j",
  (raw) => {
    expect(() => legacyClimbingDefinition(row({ raw }), false)).toThrow(
      expect.objectContaining({ field: "attemptFacts" }),
    );
  },
);
it("rejects unsupported grade systems and source conflicts but retains unknown grade text", () => {
  expect(() => legacyClimbingDefinition(row({ grade_system: "unsupported" }), false)).toThrow(
    LegacyClimbingFactConflict,
  );
  expect(() =>
    legacyClimbingDefinition(
      row({ raw: { climb: { uuid: "route", grades: { yds: "5.11a" } } } }),
      false,
    ),
  ).toThrow(expect.objectContaining({ field: "publishedGrades", externalId: "route" }));
  expect(legacyClimbingDefinition(row({ grade: "unrated" }), false).climb.publishedGrades).toEqual([
    { value: "unrated", system: null },
  ]);
});
it.each([
  {
    provider: "mountain-project",
    raw: { Date: "October 1, 2026 10:00:00 GMT-0700" },
    date: "2026-10-01",
  },
  { provider: "mountain-project", raw: { Date: "2026-10-01T23:50:00-07:00" }, date: "2026-10-01" },
  { provider: "mountain-project", raw: { Date: "2026-10-01T23:50:00" }, date: "2026-10-01" },
  { provider: "mountain-project", raw: { Date: null }, date: null },
  { provider: "mountain-project", raw: { Date: "" }, date: null },
  { provider: "openbeta", raw: { dateClimbed: 0 }, date: "1970-01-01" },
  { provider: "openbeta", raw: { dateClimbed: -62135596800000 }, date: "0001-01-01" },
  { provider: "openbeta", raw: { dateClimbed: 253402300799999 }, date: "9999-12-31" },
])("preserves the source calendar date $date from $provider", ({ provider, raw, date }) => {
  expect(legacyClimbingDefinition(row({ provider_id: provider, raw }), false).climbedOn).toBe(date);
});
it.each([-62167219200000, 253402300800000, NaN, "2026-10-01", true])(
  "rejects an invalid OpenBeta source date %s",
  (dateClimbed) => {
    expect(() => legacyClimbingDefinition(row({ raw: { dateClimbed } }), false)).toThrow(
      expect.objectContaining({ field: "climbedOn" }),
    );
  },
);
it("rejects malformed dates instead of inventing a date", () => {
  expect(() =>
    legacyClimbingDefinition(
      row({ provider_id: "mountain-project", raw: { Date: "invalid-date" } }),
      false,
    ),
  ).toThrow(expect.objectContaining({ field: "climbedOn" }));
});
it.each([
  { provider: "mountain-project", raw: { Date: "2026-10-01" } },
  { provider: "openbeta", raw: { dateClimbed: 1790812800000 } },
  { provider: "thecrag", raw: { ascent: { date: "2026-10-01" } } },
  { provider: "kaya", raw: { id: 12, climb: { id: 42 }, date: "2026-10-01" } },
  { provider: "kaya-export", raw: { date: "2026-10-01" } },
])("keeps an independently stored source date for $provider", ({ provider, raw }) => {
  expect(
    legacyClimbingDefinition(
      row({ provider_id: provider, unattached_date: "2026-09-30", raw }),
      false,
    ).climbedOn,
  ).toBe("2026-09-30");
});
it.each([
  ["https://mountainproject.com/route/123", "123"],
  ["https://www.mountainproject.com/route/123/name", "123"],
  ["https://wrong.example/route/123", null],
  ["https://mountainproject.com/prefix/route/123", null],
  ["https://mountainproject.com/area/123", null],
  ["https://mountainproject.com/route/123suffix", null],
  ["malformed", null],
])("verifies Mountain Project target identity from %s", (URL, target) => {
  const definition = legacyClimbingDefinition(
    row({ provider_id: "mountain-project", raw: { URL } }),
    false,
  );
  expect(definition.climb.externalId).toBe(target);
  expect(definition.climb.publishedGrades).toEqual([{ value: "5.10a", system: "yds" }]);
  expect(definition.reportedGrades).toEqual([]);
});
it.each([
  ["lead", { ropeMethod: "lead" }],
  ["top-rope", { ropeMethod: "top_rope" }],
  ["follow", { ropeMethod: "follow" }],
  ["unroped", { ropeMethod: "unroped" }],
  ["unknown", {}],
] as const)("preserves only the recorded legacy method %s", (legacy_climb_style, facts) => {
  expect(legacyClimbingDefinition(row({ legacy_climb_style }), false).facts).toStrictEqual(facts);
});
it("recovers the complete retained OpenBeta graph and independent grade roles", () => {
  const definition = legacyClimbingDefinition(
    row({
      location_path: [
        { name: "State", externalId: "state" },
        { name: "Area", externalId: "area" },
      ],
      raw: {
        dateClimbed: 0,
        grade: "V4",
        notes: "  note  ",
        climb: {
          uuid: "  route  ",
          name: "  Updated  ",
          grades: {
            vscale: "V4",
            font: "6B",
            yds: "5.10a",
            french: "6a",
            uiaa: "VI",
            ewbank: "19",
            brazilianCrux: "V",
            wi: "WI3",
          },
          metadata: { lat: 0, lng: 0 },
          parent: { metadata: { lat: 10, lng: 20 } },
          pitches: [
            { id: "pitch", parentId: "route", pitchNumber: 1, grades: { yds: "5.10a" } },
            { id: "unknown", parentId: "route", pitchNumber: 0, grades: { wi: "WI3" } },
          ],
        },
      },
    }),
    false,
  );
  expect(definition).toStrictEqual({
    externalId: "source-log",
    climbedOn: "1970-01-01",
    notes: "note",
    recordedCount: null,
    facts: {},
    qualifier: undefined,
    reportedGrades: [{ value: "V4", system: "v_scale" }],
    climb: {
      externalId: "route",
      name: "Updated",
      kind: "route",
      routeProtection: null,
      setting: null,
      coordinates: { latitude: 0, longitude: 0 },
      publishedGrades: [
        { value: "V4", system: "v_scale" },
        { value: "6B", system: "font" },
        { value: "5.10a", system: "yds" },
        { value: "6a", system: "french" },
        { value: "VI", system: null },
        { value: "19", system: "ewbank" },
        { value: "V", system: "brazilian_crux" },
        { value: "WI3", system: "water_ice" },
      ],
      areas: [
        { name: "State", externalId: "state" },
        { name: "Area", externalId: "area", coordinates: { latitude: 10, longitude: 20 } },
      ],
      pitches: [
        { externalId: "pitch", number: 1, publishedGrades: [{ value: "5.10a", system: "yds" }] },
        { externalId: "unknown", publishedGrades: [{ value: "WI3", system: "water_ice" }] },
      ],
    },
  });
});
it.each([
  { opinion: "5.10a", published: [], reported: [{ value: "5.10a", system: "yds" }] },
  {
    opinion: "V4",
    published: [{ value: "5.10a", system: "yds" }],
    reported: [{ value: "V4", system: "v_scale" }],
  },
  { opinion: "", published: [{ value: "5.10a", system: "yds" }], reported: [] },
] as const)(
  "preserves the role of a retained OpenBeta opinion $opinion",
  ({ opinion, published, reported }) => {
    const definition = legacyClimbingDefinition(
      row({ raw: { grade: opinion, climb: { name: " " } } }),
      false,
    );
    expect(definition.climb.name).toBe("Corner");
    expect(definition.climb.publishedGrades).toEqual(published);
    expect(definition.reportedGrades).toEqual(reported);
    expect(definition.facts).toStrictEqual({});
  },
);
it("retains an unknown opinion scale alongside a verified catalogue grade", () => {
  expect(
    legacyClimbingDefinition(
      row({ raw: { grade: "unrated", climb: { grades: { yds: "5.10a" } } } }),
      false,
    ).reportedGrades,
  ).toEqual([{ value: "unrated", system: null }]);
});
it("does not manufacture partial GPS and rejects mismatched pitch ownership", () => {
  const definition = legacyClimbingDefinition(
    row({
      location_path: [{ name: "Area", externalId: "area" }],
      raw: { climb: { metadata: { lat: 0 }, parent: { metadata: { lng: 0 } } } },
    }),
    false,
  );
  expect(definition.climb).toEqual({
    externalId: null,
    name: "Corner",
    kind: "route",
    publishedGrades: [{ value: "5.10a", system: "yds" }],
    routeProtection: null,
    setting: null,
    areas: [{ name: "Area", externalId: "area" }],
  });
  expect(() =>
    legacyClimbingDefinition(
      row({
        raw: {
          climb: {
            uuid: "route",
            pitches: [{ id: "pitch", parentId: "other", pitchNumber: 1, grades: {} }],
          },
        },
      }),
      false,
    ),
  ).toThrow(expect.objectContaining({ field: "pitches", externalId: "route" }));
});
it.each(["prefix1000_2001", "1000_2001suffix", "1000_0", "1000_"])(
  "rejects unverified KAYA target %s",
  (id) => {
    expect(() =>
      legacyClimbingDefinition(
        row({ provider_id: "kaya", activity_external_id: "1000", raw: { id } }),
        false,
      ),
    ).toThrow(expect.objectContaining({ field: "externalId" }));
  },
);
it.each([
  { kind: "route", lead: false, facts: { ropeMethod: "top_rope" } },
  { kind: "boulder", lead: true, facts: {} },
  { kind: "route", lead: null, facts: {} },
] as const)("preserves KAYA method evidence for $kind/$lead", ({ kind, lead, facts }) => {
  expect(
    legacyClimbingDefinition(
      row({ provider_id: "kaya", climb_type: kind, raw: { id: 12, climb: { id: 42, lead } } }),
      false,
    ).facts,
  ).toStrictEqual(facts);
});
it.each(["destination", "area", "subarea"])("recovers KAYA outdoor evidence from %s", (key) => {
  expect(
    legacyClimbingDefinition(
      row({
        provider_id: "kaya",
        raw: { id: 12, climb: { id: 42, [key]: { id: 1, name: "Area" } } },
      }),
      false,
    ).climb.setting,
  ).toBe("outdoor");
});
it.each([
  { raw: { id: 12, climb: { id: 42, gym: {} } }, setting: "indoor" },
  { raw: { id: 12, climb: { id: 42 }, gym: {} }, setting: "indoor" },
  { raw: { id: 12, climb: { id: 42 } }, setting: null },
])("recovers only KAYA's recorded setting $setting", ({ raw, setting }) => {
  expect(legacyClimbingDefinition(row({ provider_id: "kaya", raw }), false).climb.setting).toBe(
    setting,
  );
});
it("assigns retained KAYA location GPS to the matching provider area", () => {
  const definition = legacyClimbingDefinition(
    row({
      provider_id: "kaya",
      location_path: [
        { name: "Region", externalId: "9" },
        { name: "Wall", externalId: "42" },
        { name: "Gym", externalId: "99" },
      ],
      raw: {
        id: 12,
        climb: {
          id: 42,
          destination: { id: 9, latitude: "0", longitude: "0" },
          area: { id: 42, latitude: "37", longitude: "-122" },
          subarea: { id: 999, latitude: 10, longitude: 20 },
          gym: { id: 99, latitude: 1 },
        },
      },
    }),
    false,
  );
  expect(definition.climb.areas).toEqual([
    { name: "Region", externalId: "9", coordinates: { latitude: 0, longitude: 0 } },
    { name: "Wall", externalId: "42", coordinates: { latitude: 37, longitude: -122 } },
    { name: "Gym", externalId: "99" },
  ]);
});
it("preserves theCrag's independent source fields and does not extend its Attempt semantics to other providers", () => {
  const definition = legacyClimbingDefinition(
    row({
      provider_id: "thecrag",
      raw: {
        ascent: {
          route: { id: 42, name: "  New  " },
          markdown: "  note  ",
          climbedGearStyle: "Sport",
          tick: { name: "Repeat" },
        },
      },
    }),
    false,
  );
  expect(definition.climb.externalId).toBe("42");
  expect(definition.climb.name).toBe("New");
  expect(definition.notes).toBe("note");
  expect(definition.facts).toStrictEqual({
    protectionUsed: ["sport"],
    hadCompletedBefore: true,
    outcome: "completed",
    fellOrHung: false,
    usedAid: false,
  });
  expect(
    legacyClimbingDefinition(
      row({ provider_id: "thecrag", raw: { ascent: { tick: { label: "Attempt" } } } }),
      false,
    ).facts,
  ).toStrictEqual({ outcome: "failed" });
  expect(legacyClimbingDefinition(row({ result_style: "Attempt" }), false).facts).toStrictEqual({});
  expect(
    legacyClimbingDefinition(
      row({ provider_id: "thecrag", raw: { ascent: { route: { id: Infinity } } } }),
      false,
    ).climb.externalId,
  ).toBeNull();
});
it.each([
  {
    label: "Onsight",
    facts: {
      outcome: "completed",
      fellOrHung: false,
      usedAid: false,
      attemptIndex: 1,
      receivedBeta: false,
    },
    qualifier: "free-onsight",
  },
  {
    label: "On Sight",
    facts: {
      outcome: "completed",
      fellOrHung: false,
      usedAid: false,
      attemptIndex: 1,
      receivedBeta: false,
    },
    qualifier: "free-onsight",
  },
  {
    label: "Aid Onsight",
    facts: { usedAid: true, outcome: "completed", attemptIndex: 1, receivedBeta: false },
    qualifier: "aid-onsight",
  },
  {
    label: "Aid Flash",
    facts: { usedAid: true, outcome: "completed", attemptIndex: 1, receivedBeta: true },
    qualifier: "aid-flash",
  },
  {
    label: "Flash",
    facts: { outcome: "completed", fellOrHung: false, usedAid: false, attemptIndex: 1 },
    qualifier: "free-flash",
    history: true,
  },
  { label: "Lead Solo", facts: { solo: true, ropeMethod: "lead" } },
  { label: "Top Rope Solo", facts: { solo: true, ropeMethod: "top_rope" } },
  { label: "Aid Solo", facts: { usedAid: true, solo: true } },
  {
    label: "Pinkpoint",
    facts: {
      usedPreplacedProtection: true,
      outcome: "completed",
      fellOrHung: false,
      usedAid: false,
    },
    qualifier: "free-send",
  },
  {
    label: "Ground-up Redpoint",
    facts: {
      priorFailedAttemptsGroundUp: true,
      outcome: "completed",
      fellOrHung: false,
      usedAid: false,
    },
    qualifier: "free-send",
  },
  { label: "Dog", facts: { outcome: "completed", fellOrHung: true } },
  { label: "Hang Dog", facts: { outcome: "completed", fellOrHung: true } },
  { label: "Tick", facts: { outcome: "completed" } },
  { label: "French Free", facts: { usedAid: true } },
  { label: "FrenchFree", facts: { usedAid: true } },
  { label: "Dab", facts: { outcome: "completed", dabbed: true }, qualifier: "dab" },
  { label: "unknown", facts: {} },
] satisfies Array<{
  label: string;
  facts: Record<string, unknown>;
  qualifier?: string;
  history?: boolean;
}>)("preserves the exact retained meaning of $label", ({ label, facts, ...options }) => {
  const definition = legacyClimbingDefinition(
    row({
      provider_id: "mountain-project",
      raw: { URL: "https://mountainproject.com/route/123", Rating: "5.10a" },
      result_style: label,
    }),
    "history" in options && options.history === true,
  );
  expect(definition.facts).toStrictEqual(facts);
  expect(definition.qualifier).toBe("qualifier" in options ? options.qualifier : undefined);
});
it.each(["Clean", "Send", "Redpoint", "Pinkpoint"])(
  "preserves aid completion %s without inventing interruption facts",
  (label) => {
    expect(
      legacyClimbingDefinition(row({ legacy_climb_style: "aid", result_style: label }), false)
        .facts,
    ).toStrictEqual({
      usedAid: true,
      outcome: "completed",
      ...(label === "Pinkpoint" ? { usedPreplacedProtection: true } : {}),
    });
  },
);
