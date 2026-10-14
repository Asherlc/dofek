import { expect, it } from "vitest";
import { type LegacyClimbingRow, legacyClimbingDefinition } from "./climbing-log-legacy-source.ts";

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
