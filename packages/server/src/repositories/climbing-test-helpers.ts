import { climbingAttemptSchema, climbingLogEntrySchema } from "@dofek/training/climbing-log";
import type { ClimbingLogEntryDetail } from "../contracts/climbing-log-contracts.ts";
import type { ActivityRow } from "../models/activity.ts";

export function climbingLogEntryFixture(
  overrides: Partial<ClimbingLogEntryDetail> = {},
): ClimbingLogEntryDetail {
  return {
    id: "20000000-0000-4000-8000-000000000001",
    userId: "20000000-0000-4000-8000-000000000002",
    providerId: "openbeta",
    externalId: "source-log",
    climbId: null,
    activityId: null,
    climbedOn: null,
    discipline: null,
    title: null,
    notes: null,
    reportedGrades: [],
    board: null,
    wallAngle: null,
    holdType: null,
    sourceName: null,
    raw: null,
    providerAbsentAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    climb: null,
    attempts: [],
    recordedClimbAttemptCount: 0,
    recordedPitchAttemptCount: 0,
    recordedClimbOutcome: null,
    pitchResults: [],
    displayGrade: null,
    sourceLinks: [],
    ...overrides,
  };
}
export function climbingLogDatabaseFixture(detail: ClimbingLogEntryDetail) {
  return {
    log: climbingLogEntrySchema.strip().parse(detail),
    climb: detail.climb,
    attempts: detail.attempts.map((attempt) => climbingAttemptSchema.strip().parse(attempt)),
  };
}

export function climbingClimbFixture(
  providerId = "openbeta",
): NonNullable<ClimbingLogEntryDetail["climb"]> {
  const userId = "20000000-0000-4000-8000-000000000002";
  return {
    id: "20000000-0000-4000-8000-000000000003",
    userId,
    providerId,
    externalId: "source-climb",
    name: "Corner",
    kind: "route",
    areaId: "20000000-0000-4000-8000-000000000004",
    publishedGrades: [{ value: "5.10a", system: "yds" }],
    setting: null,
    routeProtection: null,
    coordinates: null,
    pitches: [],
    areaPath: [
      {
        id: "20000000-0000-4000-8000-000000000004",
        userId,
        providerId,
        externalId: "source-area",
        name: "Wall",
        parentAreaId: null,
        coordinates: null,
      },
    ],
  };
}
export function climbingAttemptFixture(
  climbingLogEntryId: string,
  overrides: Partial<ClimbingLogEntryDetail["attempts"][number]> = {},
): ClimbingLogEntryDetail["attempts"][number] {
  return {
    id: "20000000-0000-4000-8000-000000000005",
    climbingLogEntryId,
    scope: "climb",
    pitchId: null,
    parentAttemptId: null,
    attemptIndex: null,
    outcome: null,
    ropeMethod: null,
    solo: null,
    protectionUsed: null,
    usedPreplacedProtection: null,
    usedAid: null,
    fellOrHung: null,
    dabbed: null,
    receivedBeta: null,
    hadCompletedBefore: null,
    priorFailedAttemptsGroundUp: null,
    notes: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    rockResultLabels: [],
    ...overrides,
  };
}

export function climbingActivityFixture(overrides: Partial<ActivityRow> = {}): ActivityRow {
  return {
    id: "10000000-0000-4000-8000-000000000001",
    canonical_type: "climbing",
    modality: null,
    started_at: "2026-01-02T00:30:00.000Z",
    displayed_date: "2026-01-01",
    ended_at: null,
    name: "Climbing",
    notes: null,
    perceived_exertion: null,
    provider_id: "strava",
    timezone: null,
    start_utc_offset_minutes: null,
    end_utc_offset_minutes: null,
    local_time_source: "unknown",
    subsource: null,
    source_providers: ["strava"],
    source_external_ids: null,
    avg_hr: null,
    max_hr: null,
    avg_power: null,
    max_power: null,
    avg_speed: null,
    max_speed: null,
    avg_cadence: null,
    total_distance: null,
    elevation_gain_m: null,
    elevation_loss_m: null,
    sample_count: null,
    provider_absent_at: null,
    ...overrides,
  };
}
