import type { ClimbingGradePreference } from "@dofek/training/climbing-grades";
import { describe, expect, it, vi } from "vitest";
import {
  ClimbingActivityEntry,
  ClimbingActivityEntryRepository,
} from "./climbing-activity-entry-repository.ts";
import { emptyClimbingContext, queryText } from "./climbing-test-helpers.ts";

describe("ClimbingActivityEntry", () => {
  it("serializes to API shape", () => {
    const row = new ClimbingActivityEntry({
      id: "entry-1",
      climbType: "boulder",
      gradeSystem: "v_scale",
      grade: "V4",
      sent: true,
      attemptCount: 7,
      attempts: [],
      ascentType: "Redpoint",
      holdType: null,
      routeName: "Blue Arete",
      locationName: "Pacific Pipe",
      sourceName: "Kaya",
      wallAngleDegrees: null,
      context: emptyClimbingContext("kaya"),
    });

    expect(row.toDetail()).toEqual({
      id: "entry-1",
      climbType: "boulder",
      gradeSystem: "v_scale",
      grade: "V4",
      sent: true,
      attemptCount: 7,
      attempts: [],
      ascentType: "Redpoint",
      holdType: null,
      routeName: "Blue Arete",
      locationName: "Pacific Pipe",
      sourceName: "Kaya",
      wallAngleDegrees: null,
      context: emptyClimbingContext("kaya"),
    });
  });

  it("preserves absent aggregate attempt and outcome observations as null", async () => {
    const execute = vi.fn().mockResolvedValue([
      {
        id: "00000000-0000-4000-8000-000000000001",
        provider_id: "kaya",
        climb_type: "boulder",
        grade_system: "v_scale",
        grade: "V3",
        sent: null,
        attempt_count: null,
        attempts: [],
        ascent_type: null,
        hold_type: null,
        route_name: null,
        location_name: null,
        lead: null,
        source_name: null,
        wall_angle_degrees: null,
        context: emptyClimbingContext("kaya"),
      },
    ]);
    const repository = new ClimbingActivityEntryRepository(
      { execute },
      "00000000-0000-4000-8000-000000000002",
      "UTC",
    );

    const [entry] = await repository.getActivityEntries("00000000-0000-4000-8000-000000000003");

    expect(entry?.toDetail()).toMatchObject({
      attemptCount: null,
      sent: null,
      sourceName: null,
    });
  });
});

describe("ClimbingActivityEntryRepository", () => {
  function executeDb(execute: CallableVitestMock) {
    return { execute };
  }

  function makeRepository(
    rows: Record<string, unknown>[] = [],
    gradePreference?: ClimbingGradePreference,
  ) {
    const execute = vi.fn().mockResolvedValue(rows);
    const repo = new ClimbingActivityEntryRepository(
      executeDb(execute),
      "user-1",
      "America/Los_Angeles",
      undefined,
      gradePreference,
    );
    return { repo, execute };
  }

  describe("getActivityEntries", () => {
    it("retains the preferred context provider and its complete metadata snapshot", async () => {
      const left = {
        providerId: "mountain-project",
        locationPath: [{ name: "Wall", externalId: null, kind: null }],
        board: null,
        wallAngle: null,
        climbStyle: "top-rope",
        resultStyle: null,
      };
      const right = {
        providerId: "openbeta",
        locationPath: [{ name: "Wall", externalId: "wall-uuid", kind: null }],
        board: { name: "Training Board", externalId: "board-uuid" },
        wallAngle: { value: -20, unit: null },
        climbStyle: "top-rope",
        resultStyle: "Fell/Hung",
      };
      const base = {
        climb_type: "route",
        grade_system: "yds",
        grade: "5.10a",
        attempts: [],
        ascent_type: null,
        hold_type: null,
        route_name: "Corner",
        location_name: "Wall",
        lead: false,
        wall_angle_degrees: null,
      };
      const { repo } = makeRepository([
        {
          ...base,
          id: "mp",
          provider_id: "mountain-project",
          source_name: "Mountain Project",
          sent: null,
          attempt_count: null,
          context: left,
        },
        {
          ...base,
          id: "ob",
          provider_id: "openbeta",
          source_name: "OpenBeta",
          sent: false,
          attempt_count: null,
          context: right,
        },
      ]);
      const entries = await repo.getActivityEntries("activity");
      expect(entries).toHaveLength(1);
      expect(entries[0]?.toDetail()).toMatchObject({
        context: right,
        sourceName: "Mountain Project, OpenBeta",
        sent: false,
        attemptCount: null,
      });
    });
    it("returns normalized entries for an activity member", async () => {
      const { repo } = makeRepository([
        {
          id: "entry-1",
          provider_id: "kaya",
          climb_type: "boulder",
          grade_system: "v_scale",
          grade: "v4",
          sent: true,
          attempt_count: 7,
          attempts: [],
          ascent_type: "Redpoint",
          hold_type: null,
          route_name: "Blue Arete",
          location_name: "Pacific Pipe",
          lead: null,
          source_name: "Kaya",
          wall_angle_degrees: null,
          context: emptyClimbingContext("kaya"),
        },
      ]);

      const result = await repo.getActivityEntries("activity-1");

      expect(result).toHaveLength(1);
      expect(result[0]).toBeInstanceOf(ClimbingActivityEntry);
      expect(result[0]?.toDetail()).toEqual({
        id: "entry-1",
        climbType: "boulder",
        gradeSystem: "v_scale",
        grade: "V4",
        sent: true,
        attemptCount: 7,
        attempts: [],
        ascentType: "Redpoint",
        holdType: null,
        routeName: "Blue Arete",
        locationName: "Pacific Pipe",
        lead: null,
        sourceName: "Kaya",
        wallAngleDegrees: null,
        context: emptyClimbingContext("kaya"),
      });
    });

    it("merges the same named climb across providers and keeps the recorded outcome", async () => {
      const { repo } = makeRepository([
        {
          id: "mountain-project-entry",
          provider_id: "mountain-project",
          climb_type: "route",
          grade_system: "yds",
          grade: "5.6",
          sent: null,
          attempt_count: null,
          attempts: [],
          ascent_type: null,
          hold_type: null,
          route_name: "Test Crack",
          location_name: "Test Location",
          lead: null,
          source_name: "Mountain Project",
          wall_angle_degrees: null,
          context: emptyClimbingContext("mountain-project"),
        },
        {
          id: "kaya-entry",
          provider_id: "kaya",
          climb_type: "route",
          grade_system: "yds",
          grade: "5.6",
          sent: true,
          attempt_count: 1,
          attempts: [],
          ascent_type: "Redpoint",
          hold_type: null,
          route_name: "Test Crack",
          location_name: "Test Location",
          lead: null,
          source_name: "Kaya",
          wall_angle_degrees: null,
          context: emptyClimbingContext("kaya"),
        },
      ]);

      const entries = await repo.getActivityEntries("activity-1");

      expect(entries.map((entry) => entry.toDetail())).toMatchObject([
        {
          id: "kaya-entry",
          sent: true,
          attemptCount: 1,
          sourceName: "Mountain Project, Kaya",
        },
      ]);
    });

    it("preserves repeated sends within a provider while merging each provider label once", async () => {
      const entry = {
        climb_type: "route",
        grade_system: "yds",
        grade: "5.6",
        sent: true,
        attempt_count: 1,
        attempts: [],
        ascent_type: null,
        hold_type: null,
        route_name: "Test Crack",
        location_name: "Test Location",
        lead: null,
        wall_angle_degrees: null,
      };
      const { repo } = makeRepository([
        {
          ...entry,
          id: "provider-a-1",
          provider_id: "provider-a",
          source_name: "Provider A",
          context: emptyClimbingContext("provider-a"),
        },
        {
          ...entry,
          id: "provider-b-1",
          provider_id: "provider-b",
          source_name: "Provider B",
          context: emptyClimbingContext("provider-b"),
        },
        {
          ...entry,
          id: "provider-b-2",
          provider_id: "provider-b",
          source_name: "Provider B",
          context: emptyClimbingContext("provider-b"),
        },
        {
          ...entry,
          id: "provider-c-1",
          provider_id: "provider-c",
          source_name: "Provider C",
          context: emptyClimbingContext("provider-c"),
        },
      ]);

      const entries = await repo.getActivityEntries("activity-1");

      expect(entries.map((climb) => climb.toDetail())).toMatchObject([
        { sourceName: "Provider A, Provider B, Provider C" },
        { id: "provider-b-2", sourceName: "Provider B" },
      ]);
    });

    it("normalizes grade, route, and location before matching provider entries", async () => {
      const { repo } = makeRepository([
        {
          id: "mountain-project-entry",
          provider_id: "mountain-project",
          climb_type: "route",
          grade_system: "yds",
          grade: " 5.10c ",
          sent: null,
          attempt_count: null,
          attempts: [],
          ascent_type: null,
          hold_type: null,
          route_name: " Test   Crack ",
          location_name: " Test   Location ",
          lead: null,
          source_name: "Mountain Project",
          wall_angle_degrees: null,
          context: emptyClimbingContext("mountain-project"),
        },
        {
          id: "kaya-entry",
          provider_id: "kaya",
          climb_type: "route",
          grade_system: "yds",
          grade: "5.10C",
          sent: true,
          attempt_count: 1,
          attempts: [],
          ascent_type: null,
          hold_type: null,
          route_name: "test crack",
          location_name: "test location",
          lead: null,
          source_name: "Kaya",
          wall_angle_degrees: null,
          context: emptyClimbingContext("kaya"),
        },
      ]);

      const entries = await repo.getActivityEntries("activity-1");

      expect(entries).toHaveLength(1);
      expect(entries[0]?.toDetail()).toMatchObject({
        sent: true,
        sourceName: "Mountain Project, Kaya",
      });
    });

    it.each([
      ["climb type", { climb_type: "boulder" }],
      ["grade system", { grade_system: "french" }],
      ["grade", { grade: "5.7" }],
      ["route name", { route_name: "Other Crack" }],
      ["location", { location_name: "Other Location" }],
      ["lead status", { lead: true }],
    ])("keeps entries with different %s separate", async (_identityPart, change) => {
      const base = {
        climb_type: "route",
        grade_system: "yds",
        grade: "5.6",
        sent: true,
        attempt_count: 1,
        attempts: [],
        ascent_type: null,
        hold_type: null,
        route_name: "Test Crack",
        location_name: "Test Location",
        lead: null,
        source_name: null,
        wall_angle_degrees: null,
      };
      const { repo } = makeRepository([
        {
          ...base,
          id: "mountain-project-entry",
          provider_id: "mountain-project",
          context: emptyClimbingContext("mountain-project"),
        },
        {
          ...base,
          ...change,
          id: "kaya-entry",
          provider_id: "kaya",
          context: emptyClimbingContext("kaya"),
        },
      ]);

      const entries = await repo.getActivityEntries("activity-1");

      expect(entries).toHaveLength(2);
    });

    it.each([
      ["route name", { route_name: null, location_name: "Test Location" }],
      ["location", { route_name: "Test Crack", location_name: null }],
    ])("does not infer identity when the %s is missing", async (_missingPart, names) => {
      const base = {
        climb_type: "route",
        grade_system: "yds",
        grade: "5.6",
        sent: true,
        attempt_count: 1,
        attempts: [],
        ascent_type: null,
        hold_type: null,
        route_name: "Test Crack",
        location_name: "Test Location",
        lead: null,
        source_name: null,
        wall_angle_degrees: null,
      };
      const { repo } = makeRepository([
        {
          ...base,
          ...names,
          id: "mountain-project-entry",
          provider_id: "mountain-project",
          context: emptyClimbingContext("mountain-project"),
        },
        {
          ...base,
          ...names,
          id: "kaya-entry",
          provider_id: "kaya",
          context: emptyClimbingContext("kaya"),
        },
      ]);

      const entries = await repo.getActivityEntries("activity-1");

      expect(entries).toHaveLength(2);
    });

    it("keeps repeated entries from one provider and prefers retained attempts", async () => {
      const base = {
        climb_type: "route",
        grade_system: "yds",
        grade: "5.6",
        sent: true,
        attempt_count: 1,
        attempts: [],
        ascent_type: null,
        hold_type: null,
        route_name: "Test Crack",
        location_name: "Test Location",
        lead: null,
        source_name: null,
        wall_angle_degrees: null,
      };
      const { repo } = makeRepository([
        {
          ...base,
          id: "source-a",
          provider_id: "kaya",
          context: emptyClimbingContext("kaya"),
        },
        {
          ...base,
          id: "source-b",
          provider_id: "kaya",
          context: emptyClimbingContext("kaya"),
        },
        {
          ...base,
          id: "source-c",
          provider_id: "mountain-project",
          attempts: [{ attemptIndex: 1, failureReason: null, notes: null, outcome: "sent" }],
          context: emptyClimbingContext("mountain-project"),
        },
      ]);

      const entries = await repo.getActivityEntries("activity-1");

      expect(entries.map((entry) => entry.toDetail().id)).toEqual(["source-b", "source-c"]);
    });

    it("prefers a recorded outcome when aggregate attempt counts are unavailable", async () => {
      const base = {
        climb_type: "route",
        grade_system: "yds",
        grade: "5.6",
        attempt_count: null,
        attempts: [],
        ascent_type: null,
        hold_type: null,
        route_name: "Test Crack",
        location_name: "Test Location",
        lead: null,
        source_name: null,
        wall_angle_degrees: null,
      };
      const { repo } = makeRepository([
        {
          ...base,
          id: "unknown",
          provider_id: "mountain-project",
          sent: null,
          context: emptyClimbingContext("mountain-project"),
        },
        {
          ...base,
          id: "recorded",
          provider_id: "kaya",
          sent: false,
          context: emptyClimbingContext("kaya"),
        },
      ]);

      const entries = await repo.getActivityEntries("activity-1");

      expect(entries[0]?.toDetail().id).toBe("recorded");
      expect(entries[0]?.toDetail().sent).toBe(false);
    });

    it("prefers aggregate attempt counts when outcome observations match", async () => {
      const base = {
        climb_type: "route",
        grade_system: "yds",
        grade: "5.6",
        sent: true,
        attempts: [],
        ascent_type: null,
        hold_type: null,
        route_name: "Test Crack",
        location_name: "Test Location",
        lead: null,
        source_name: null,
        wall_angle_degrees: null,
      };
      const { repo } = makeRepository([
        {
          ...base,
          id: "unknown-count",
          provider_id: "mountain-project",
          attempt_count: null,
          context: emptyClimbingContext("mountain-project"),
        },
        {
          ...base,
          id: "known-count",
          provider_id: "kaya",
          attempt_count: 2,
          context: emptyClimbingContext("kaya"),
        },
      ]);

      const entries = await repo.getActivityEntries("activity-1");

      expect(entries[0]?.toDetail().id).toBe("known-count");
      expect(entries[0]?.toDetail().attemptCount).toBe(2);
    });

    it("keeps the first provider record when duplicate details are equally complete", async () => {
      const base = {
        climb_type: "route",
        grade_system: "yds",
        grade: "5.6",
        sent: true,
        attempt_count: 1,
        attempts: [],
        ascent_type: null,
        hold_type: null,
        route_name: "Test Crack",
        location_name: "Test Location",
        lead: null,
        source_name: null,
        wall_angle_degrees: null,
      };
      const { repo } = makeRepository([
        {
          ...base,
          id: "first",
          provider_id: "mountain-project",
          context: emptyClimbingContext("mountain-project"),
        },
        {
          ...base,
          id: "second",
          provider_id: "kaya",
          context: emptyClimbingContext("kaya"),
        },
      ]);

      const entries = await repo.getActivityEntries("activity-1");

      expect(entries[0]?.toDetail().id).toBe("first");
    });

    it("keeps a null source name null when merging duplicate entries", async () => {
      const base = {
        climb_type: "route",
        grade_system: "yds",
        grade: "5.6",
        sent: true,
        attempt_count: 1,
        attempts: [],
        ascent_type: null,
        hold_type: null,
        route_name: "Test Crack",
        location_name: "Test Location",
        lead: null,
        source_name: null,
        wall_angle_degrees: null,
      };
      const { repo } = makeRepository([
        {
          ...base,
          id: "source-a",
          provider_id: "mountain-project",
          context: emptyClimbingContext("mountain-project"),
        },
        {
          ...base,
          id: "source-b",
          provider_id: "kaya",
          context: emptyClimbingContext("kaya"),
        },
      ]);

      const entries = await repo.getActivityEntries("activity-1");

      expect(entries[0]?.toDetail().sourceName).toBeNull();
    });

    it("hydrates all members from the already-resolved stable activity group", async () => {
      const { repo, execute } = makeRepository([]);

      await repo.getActivityEntries("activity-1");

      const text = queryText(execute.mock.calls[0]?.[0]);
      expect(text).toContain("fitness.v_activity");
      expect(text).toContain("ce.activity_id = ANY(a.member_activity_ids)");
      expect(text).toContain("ce.attempt_count");
      expect(text).toContain("jsonb_agg");
      expect(text).toContain("ce.ascent_type");
      expect(text).toContain("ce.lead");
      expect(text).toContain("a.id = ");
      expect(text).toContain("a.user_id = ");
      expect(text).toContain("ORDER BY");
    });

    it("keeps activity entries with invalid grades in deterministic source order", async () => {
      const { repo } = makeRepository([
        {
          id: "entry-1",
          provider_id: "kaya",
          climb_type: "boulder",
          grade_system: "v_scale",
          grade: "not-a-grade",
          sent: false,
          attempt_count: 1,
          attempts: [],
          ascent_type: null,
          hold_type: null,
          route_name: null,
          location_name: null,
          source_name: "Kaya",
          wall_angle_degrees: null,
          context: emptyClimbingContext("kaya"),
        },
        {
          id: "entry-2",
          provider_id: "kaya",
          climb_type: "boulder",
          grade_system: "v_scale",
          grade: "also-not-a-grade",
          sent: false,
          attempt_count: 1,
          attempts: [],
          ascent_type: null,
          hold_type: null,
          route_name: null,
          location_name: null,
          source_name: "Kaya",
          wall_angle_degrees: null,
          context: emptyClimbingContext("kaya"),
        },
      ]);

      const entries = await repo.getActivityEntries("activity-1");

      expect(entries.map((entry) => entry.toDetail().id)).toEqual(["entry-1", "entry-2"]);
    });

    it("preserves an unparseable source grade after valid converted entries", async () => {
      const { repo } = makeRepository(
        [
          {
            id: "entry-valid",
            provider_id: "kaya",
            climb_type: "boulder",
            grade_system: "v_scale",
            grade: "V4",
            sent: true,
            attempt_count: 1,
            attempts: [],
            ascent_type: null,
            hold_type: null,
            route_name: null,
            location_name: null,
            source_name: "Kaya",
            wall_angle_degrees: null,
            context: emptyClimbingContext("kaya"),
          },
          {
            id: "entry-invalid",
            provider_id: "kaya",
            climb_type: "boulder",
            grade_system: "v_scale",
            grade: "not-a-grade",
            sent: false,
            attempt_count: 1,
            attempts: [],
            ascent_type: null,
            hold_type: null,
            route_name: null,
            location_name: null,
            source_name: "Kaya",
            wall_angle_degrees: null,
            context: emptyClimbingContext("kaya"),
          },
        ],
        { boulder: "font", route: "french" },
      );

      const entries = await repo.getActivityEntries("activity-1");

      expect(entries.map((entry) => entry.toDetail())).toMatchObject([
        { id: "entry-valid", gradeSystem: "font", grade: "6a+/6b+" },
        { id: "entry-invalid", gradeSystem: "v_scale", grade: "not-a-grade" },
      ]);
    });

    it("orders valid grades from hardest to easiest and uses entry IDs to break ties", async () => {
      const { repo } = makeRepository([
        {
          id: "entry-b",
          provider_id: "kaya",
          climb_type: "boulder",
          grade_system: "v_scale",
          grade: "V4",
          sent: true,
          attempt_count: 1,
          attempts: [],
          ascent_type: null,
          hold_type: null,
          route_name: null,
          location_name: null,
          source_name: "Kaya",
          wall_angle_degrees: null,
          context: emptyClimbingContext("kaya"),
        },
        {
          id: "entry-a",
          provider_id: "kaya",
          climb_type: "boulder",
          grade_system: "v_scale",
          grade: "V4",
          sent: true,
          attempt_count: 1,
          attempts: [],
          ascent_type: null,
          hold_type: null,
          route_name: null,
          location_name: null,
          source_name: "Kaya",
          wall_angle_degrees: null,
          context: emptyClimbingContext("kaya"),
        },
        {
          id: "entry-c",
          provider_id: "kaya",
          climb_type: "boulder",
          grade_system: "v_scale",
          grade: "V3",
          sent: true,
          attempt_count: 1,
          attempts: [],
          ascent_type: null,
          hold_type: null,
          route_name: null,
          location_name: null,
          source_name: "Kaya",
          wall_angle_degrees: null,
          context: emptyClimbingContext("kaya"),
        },
      ]);

      const entries = await repo.getActivityEntries("activity-1");

      expect(entries.map((entry) => entry.toDetail().id)).toEqual([
        "entry-a",
        "entry-b",
        "entry-c",
      ]);
    });

    it("keeps detail tied to the selected activity's attached entries", async () => {
      const { repo, execute } = makeRepository([]);

      await repo.getActivityEntries("activity-1");

      const text = queryText(execute.mock.calls[0]?.[0]);
      expect(text).toContain("ce.activity_id = ANY(a.member_activity_ids)");
      expect(text).not.toContain("unattached_date");
    });
  });
});
