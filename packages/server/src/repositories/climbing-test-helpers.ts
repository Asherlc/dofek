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
    holdTypes: null,
    sourceName: null,
    raw: null,
    providerAbsentAt: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    climb: null,
    mapLocation: null,
    photoLogEntryId: null,
    attempts: [],
    recordedClimbAttemptCount: 0,
    recordedPitchAttemptCount: 0,
    recordedClimbOutcome: null,
    freeSend: null,
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
    areaPath: detail.areaPath ?? detail.climb?.areaPath ?? [],
    logAreaId: detail.areaPath?.at(-1)?.id ?? null,
    areaGroupId: detail.areaGroupId ?? null,
    freeSend: detail.freeSend,
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
    primary_activity_id: null,
    primary_canonical_type: null,
    primary_provider_id: null,
    primary_source_name: null,
    origin_candidate_member_ids: [],
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
    origin_evidence: [],
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
    fit_recovery_error: false,
    provider_absent_at: null,
    ...overrides,
  };
}

export function climbingNamedLogEntryFixture(
  providerId: string,
  id = "20000000-0000-4000-8000-000000000001",
  completed = false,
): ClimbingLogEntryDetail {
  const climb = climbingClimbFixture(providerId);
  return climbingLogEntryFixture({
    id,
    providerId,
    climb,
    climbId: climb.id,
    discipline: "rock_climbing",
    sourceName: providerId,
    attempts: [
      climbingAttemptFixture(id, {
        ropeMethod: "lead",
        ...(completed ? { outcome: "completed", usedAid: false, fellOrHung: false } : {}),
      }),
    ],
  });
}
export function climbingKayaHistoryFixture() {
  const send = climbingNamedLogEntryFixture("kaya", "20000000-0000-4000-8000-000000000001", true);
  if (!send.climb) throw new Error("Expected climb");
  send.climb.externalId = "2001";
  send.externalId = "kaya:ascent:3001";
  send.activityId = "20000000-0000-4000-8000-000000000099";
  send.raw = {
    session_id: "1000",
    attempts: null,
    ascent_type: { name: " rEdPoInT " },
    date: "2026-10-01T17:15:00Z",
  };
  const failed = climbingNamedLogEntryFixture("kaya", "20000000-0000-4000-8000-000000000011");
  failed.climb = send.climb;
  failed.activityId = send.activityId;
  failed.externalId = "kaya:session:1000:attempted:1000_2001";
  failed.raw = { attempts: 1, sent: false };
  failed.attempts = [
    climbingAttemptFixture(failed.id, {
      id: "20000000-0000-4000-8000-000000000006",
      outcome: "failed",
      ropeMethod: "lead",
    }),
  ];
  return { send, failed };
}

export function climbingActivitySessionFixtures() {
  const activityId = "20000000-0000-4000-8000-000000000020";
  const otherActivityId = "20000000-0000-4000-8000-000000000021";
  const firstSessionId = "30000000-0000-4000-8000-000000000001";
  const secondSessionId = "30000000-0000-4000-8000-000000000002";
  const rows = [
    {
      activityId,
      id: firstSessionId,
      providerId: "kilter",
      memberActivityIds: ["40000000-0000-4000-8000-000000000001"],
      firstLoggedAt: "2026-11-09T18:00:00.000Z",
      lastLoggedAt: "2026-11-09T18:04:00.000Z",
    },
    {
      activityId,
      id: secondSessionId,
      providerId: "kilter",
      memberActivityIds: ["40000000-0000-4000-8000-000000000002"],
      firstLoggedAt: "2026-11-09T18:20:00.000Z",
      lastLoggedAt: "2026-11-09T18:25:00.000Z",
    },
    {
      activityId: otherActivityId,
      id: "30000000-0000-4000-8000-000000000003",
      providerId: "kilter",
      memberActivityIds: ["40000000-0000-4000-8000-000000000003"],
      firstLoggedAt: "2026-11-10T18:00:00.000Z",
      lastLoggedAt: "2026-11-10T18:01:00.000Z",
    },
  ];

  return { activityId, otherActivityId, firstSessionId, secondSessionId, rows };
}
