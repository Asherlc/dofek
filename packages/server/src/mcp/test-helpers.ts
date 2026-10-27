import type { ClimbingContext } from "@dofek/training/climbing-context";
import type { AttachedRockClimbingObservation } from "../repositories/climbing-repository.ts";
import {
  climbingAttemptFixture,
  climbingClimbFixture,
  climbingLogEntryFixture,
} from "../repositories/climbing-test-helpers.ts";

export function attachedRockClimbingObservationFixture(
  overrides: Partial<AttachedRockClimbingObservation> = {},
): AttachedRockClimbingObservation {
  return {
    activityId: "activity-1",
    date: "2026-07-09",
    climbKind: "boulder",
    attemptScope: "climb",
    displayGrade: { grade: "V5", gradeSystem: "v_scale", gradeSortValue: 70 },
    recordedAttempts: 3,
    sends: 1,
    observedOutcomes: 1,
    unknownOutcomes: 2,
    ...overrides,
  };
}

export function climbingSessionContext(): ClimbingContext {
  const { areaPath, pitches: _pitches, ...climb } = climbingClimbFixture("openbeta");
  const leaf = areaPath[0];
  if (!leaf) throw new Error("Expected test area");
  leaf.name = "Crag";
  return {
    providerId: "openbeta",
    climb,
    areaPath,
    board: { name: "Board", externalId: "board-1" },
    wallAngle: { value: -20, unit: null },
    holdTypes: null,
  };
}
export function climbingSessionDetail() {
  const context = climbingSessionContext();
  const catalogue = climbingClimbFixture("openbeta");
  const log = climbingLogEntryFixture({
    climbId: catalogue.id,
    climb: { ...catalogue, areaPath: context.areaPath },
    discipline: "rock_climbing",
    climbedOn: "2026-09-29",
    board: context.board,
    wallAngle: context.wallAngle,
    sourceName: "Mountain Project, OpenBeta",
    displayGrade: "5.10a",
    recordedClimbAttemptCount: 1,
  });
  log.attempts = [climbingAttemptFixture(log.id, { ropeMethod: "top_rope", fellOrHung: true })];
  return log;
}
export function climbingSessionResult() {
  return {
    sessions: [
      {
        activity_id: "activity-1",
        started_at: "2026-09-29T10:00:00Z",
        duration_minutes: null,
        avg_hr: null,
        name: null,
        location: "Crag",
        climbing_log_entries: [climbingSessionDetail()],
      },
    ],
    aggregates: {
      grade_distribution: [
        {
          climb_kind: "route",
          grade: "5.10a",
          grade_system: "yds",
          recorded_attempts: 1,
          sends: 0,
        },
      ],
      send_rate: 0,
      max_grade_by_kind: { boulder: null, route: null },
      volume: { rock_log_entries: 1, recorded_attempts: 1, sends: 0 },
      coverage: {
        rock_log_entries: 1,
        observed_free_send_outcomes: 1,
        unknown_free_send_outcomes: 0,
      },
    },
  };
}
