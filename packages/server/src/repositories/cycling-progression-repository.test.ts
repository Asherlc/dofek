import type { Database } from "dofek/db";
import { describe, expect, it, vi } from "vitest";
import type { z } from "zod";
import type { AccessWindow } from "../billing/entitlement.ts";
import { collectSqlText } from "../routers/test-helpers.ts";
import type { ActivityRepository, ActivitySensorStore } from "./activity-repository.ts";
import type { ActivitySensorWindow } from "./activity-sensor-types.ts";
import { CyclingProgressionRepository } from "./cycling-progression-repository.ts";

const userId = "00000000-0000-4000-8000-000000000001";
const selectedId = "00000000-0000-4000-8000-000000000002";
const priorId = "00000000-0000-4000-8000-000000000003";
const memberId = "00000000-0000-4000-8000-000000000005";
const fullAccess: AccessWindow = { kind: "full", paid: true, reason: "paid_grant" };

const window: ActivitySensorWindow = {
  activityId: selectedId,
  userId,
  startedAt: "2026-06-01T12:00:00.000Z",
  endedAt: "2026-06-01T12:10:00.000Z",
  memberActivityIds: [selectedId],
  providerType: "cycling",
};

type RideRow = {
  id: string;
  local_date: string;
  started_at: string;
  ended_at: string;
  modality: string;
  perceived_exertion: number | null;
  member_activity_ids: string[];
  effort_consistent: boolean;
};

function rideRow(overrides: Partial<RideRow> = {}): RideRow {
  return {
    id: selectedId,
    local_date: "2026-06-01",
    started_at: "2026-06-01T12:00:00.000Z",
    ended_at: "2026-06-01T12:10:00.000Z",
    modality: "indoor_cycling",
    perceived_exertion: 5,
    member_activity_ids: [selectedId],
    effort_consistent: true,
    ...overrides,
  };
}

function priorRideRow(overrides: Partial<RideRow> = {}): RideRow {
  const started_at = overrides.started_at ?? "2026-05-25T12:00:00.000Z";
  return rideRow({
    id: priorId,
    local_date: "2026-05-25",
    started_at,
    ended_at: new Date(Date.parse(started_at) + 600_000).toISOString(),
    member_activity_ids: [priorId],
    ...overrides,
  });
}

type IntervalRow = Parameters<
  typeof import("./cycling-effort-metrics.ts").recordedIntervalsForActivity
>[1][number];

function workIntervalRow(
  activityId: string,
  startedAt: string,
  overrides: Partial<IntervalRow> = {},
): IntervalRow {
  return {
    member_activity_id: activityId,
    interval_index: 0,
    label: "Work 1",
    interval_type: "workout_step",
    started_at: startedAt,
    ended_at: new Date(Date.parse(startedAt) + 300_000).toISOString(),
    source_kind: "provider_recorded",
    source_provider: "wahoo",
    source_activity_id: activityId,
    segment_type: null,
    target_intensity: null,
    target_zone: null,
    target_cadence_rpm: null,
    target_power_watts: null,
    target_resistance: null,
    work_recovery_kind: "work",
    raw: null,
    fit_source: null,
    planned_duration_seconds: null,
    recorded_timer_duration_seconds: null,
    target_power_min_watts: null,
    target_power_max_watts: null,
    ...overrides,
  };
}

type MeasurementKind = "direct" | "estimated" | "unknown";
type StreamEvidence = [string, string | null, string | null, MeasurementKind];

function sampleRows(
  activityId: string,
  power: number | null = 200,
  measurementKinds: MeasurementKind[] = ["direct"],
  sampleCount = 600,
) {
  return Array.from({ length: sampleCount }, (_, elapsedSeconds) => ({
    activity_id: activityId,
    elapsed_seconds: elapsedSeconds,
    power,
    heart_rate: null,
    cadence: null,
    source_providers: ["wahoo"],
    source_devices: ["trainer"],
    power_measurement_kinds: measurementKinds,
    stream_evidence: measurementKinds.map(
      (kind) => ["power", "wahoo", "trainer", kind] satisfies StreamEvidence,
    ),
  }));
}

type IdentityRow = {
  canonical_activity_id: string;
  source_activity_id: string;
  source_provider: string;
  source_external_id: string | null;
  kind: string;
  namespace: string | null;
  value: string;
  normalized_value: string;
  display_name: string | null;
  strength: string;
  method: string;
  source_field: string | null;
  evidence: Record<string, unknown>;
};

function identityRow(
  activityId: string,
  value: string,
  provider = "wahoo",
  overrides: Partial<IdentityRow> = {},
): IdentityRow {
  return {
    canonical_activity_id: activityId,
    source_activity_id: activityId,
    source_provider: provider,
    source_external_id: null,
    kind: "provider_workout",
    namespace: provider,
    value,
    normalized_value: value,
    display_name: "Aerobic intervals",
    strength: "exact",
    method: "workout_template_id",
    source_field: "templateId",
    evidence: {},
    ...overrides,
  };
}

interface SetupOptions {
  selected?: RideRow;
  candidates?: RideRow[];
  /** Sequential keyset pages returned by the candidate query, in fetch order. */
  candidatePages?: RideRow[][];
  intervalRows?: IntervalRow[];
  selectedPower?: number;
  candidatePower?: number;
  measurementKind?: "direct" | "estimated" | "unknown";
  measurementKinds?: MeasurementKind[];
  identities?: IdentityRow[];
  selectedSamples?: ReturnType<typeof sampleRows>;
  windowOverride?: ActivitySensorWindow | null;
}

function setup(options: SetupOptions = {}) {
  const selected = options.selected ?? rideRow();
  const candidates = options.candidates ?? [priorRideRow()];
  const candidateRows = options.candidatePages?.flat() ?? candidates;
  const intervalRows = options.intervalRows ?? [
    workIntervalRow(selectedId, selected.started_at),
    workIntervalRow(priorId, candidates[0]?.started_at ?? priorRideRow().started_at),
  ];
  const sampleCount = (ride: RideRow) =>
    Math.max(0, Math.ceil((Date.parse(ride.ended_at) - Date.parse(ride.started_at)) / 1000));
  const kinds = options.measurementKinds ?? [options.measurementKind ?? "direct"];
  const selectedSamples =
    options.selectedSamples ??
    sampleRows(selectedId, options.selectedPower ?? 200, kinds, sampleCount(selected));
  const candidateSamples = candidateRows.flatMap((candidate) =>
    sampleRows(candidate.id, options.candidatePower ?? 200, kinds, sampleCount(candidate)),
  );

  let candidatePage = 0;
  const execute = vi.fn(async (query: unknown) => {
    const text = collectSqlText(query);
    if (text.includes("cycling-progression:selected")) return [selected];
    if (text.includes("cycling-progression:candidates")) {
      const page =
        options.candidatePages?.[candidatePage] ?? (candidatePage === 0 ? candidates : []);
      candidatePage += 1;
      return page;
    }
    if (text.includes("fitness.activity_interval")) return intervalRows;
    throw new Error(`Unexpected Postgres query: ${text.slice(0, 160)}`);
  });
  const db = { execute } satisfies Pick<Database, "execute">;

  const query = vi.fn(async (_schema: z.ZodType, text: string) => {
    if (text.includes("activity_effort_identity")) return options.identities ?? [];
    if (text.includes("activity_sensor_sample")) return [...selectedSamples, ...candidateSamples];
    throw new Error(`Unexpected ClickHouse query: ${text.slice(0, 160)}`);
  });
  const store = { query } satisfies Pick<ActivitySensorStore, "query">;
  const activities: Pick<ActivityRepository, "findSensorWindow"> = {
    findSensorWindow: vi.fn(async () =>
      options.windowOverride === undefined ? window : options.windowOverride,
    ),
  };
  const repository = new CyclingProgressionRepository(
    db,
    store,
    userId,
    "UTC",
    fullAccess,
    activities,
  );
  return { repository, execute, query, candidates };
}

describe("CyclingProgressionRepository", () => {
  it("returns null when the selected activity is not an authorized canonical window", async () => {
    const { repository } = setup({ windowOverride: null });
    await expect(repository.getCyclingProgression(selectedId)).resolves.toBeNull();
  });

  it("returns null when the selected ride has no imported moderate session effort", async () => {
    const { repository } = setup({ selected: rideRow({ perceived_exertion: null }) });
    await expect(repository.getCyclingProgression(selectedId)).resolves.toBeNull();
  });

  it("rejects effort above the moderate threshold and non-finite effort", async () => {
    for (const perceived_exertion of [5.1, Number.POSITIVE_INFINITY]) {
      const { repository } = setup({ selected: rideRow({ perceived_exertion }) });
      await expect(repository.getCyclingProgression(selectedId)).resolves.toBeNull();
    }
  });

  it("rejects zero and negative session effort", async () => {
    for (const perceived_exertion of [0, -1]) {
      const { repository } = setup({ selected: rideRow({ perceived_exertion }) });
      await expect(repository.getCyclingProgression(selectedId)).resolves.toBeNull();
    }
  });

  it("filters candidates by modality and by local ordering", async () => {
    const wrongModality = setup({ candidates: [priorRideRow({ modality: "running" })] });
    await expect(wrongModality.repository.getCyclingProgression(selectedId)).resolves.toBeNull();

    const sameDate = setup({
      candidates: [
        priorRideRow({
          local_date: "2026-06-01",
          started_at: "2026-06-01T11:00:00.000Z",
          ended_at: "2026-06-01T11:10:00.000Z",
        }),
      ],
      intervalRows: [
        workIntervalRow(selectedId, window.startedAt),
        workIntervalRow(priorId, "2026-06-01T11:00:00.000Z"),
      ],
    });
    await expect(sameDate.repository.getCyclingProgression(selectedId)).resolves.toBeNull();
  });

  it("bounds candidate comparison to the 56-day window inclusively", async () => {
    const older = setup({
      candidates: [
        priorRideRow({
          local_date: "2026-03-01",
          started_at: "2026-03-01T12:00:00.000Z",
          ended_at: "2026-03-01T12:10:00.000Z",
        }),
      ],
      intervalRows: [
        workIntervalRow(selectedId, window.startedAt),
        workIntervalRow(priorId, "2026-03-01T12:00:00.000Z"),
      ],
    });
    await expect(older.repository.getCyclingProgression(selectedId)).resolves.toBeNull();

    const boundary = setup({
      candidates: [
        priorRideRow({
          local_date: "2026-04-06",
          started_at: "2026-04-06T12:00:00.000Z",
          ended_at: "2026-04-06T12:10:00.000Z",
        }),
      ],
      intervalRows: [
        workIntervalRow(selectedId, window.startedAt),
        workIntervalRow(priorId, "2026-04-06T12:00:00.000Z"),
      ],
    });
    await expect(boundary.repository.getCyclingProgression(selectedId)).resolves.toHaveProperty(
      "status",
      "ready",
    );
  });

  it("requires a recognized direct power measurement kind", async () => {
    const cases: MeasurementKind[][] = [[], ["direct", "estimated"]];
    for (const measurementKinds of cases) {
      const { repository } = setup({ measurementKinds });
      await expect(repository.getCyclingProgression(selectedId)).resolves.toBeNull();
    }
  });

  it("excludes a ride whose current members report contradictory effort", async () => {
    const selected = setup({ selected: rideRow({ effort_consistent: false }) });
    await expect(selected.repository.getCyclingProgression(selectedId)).resolves.toBeNull();
    const candidate = setup({ candidates: [priorRideRow({ effort_consistent: false })] });
    await expect(candidate.repository.getCyclingProgression(selectedId)).resolves.toBeNull();
  });

  it("rejects cross-field disagreement when peers normalize into one merged group", async () => {
    const { repository } = setup({
      selected: rideRow({ member_activity_ids: [selectedId, memberId] }),
      intervalRows: [
        workIntervalRow(selectedId, window.startedAt),
        workIntervalRow(selectedId, "2026-06-01T12:05:00.000Z", { interval_index: 1 }),
        workIntervalRow(memberId, "2026-06-01T12:05:00.200Z", {
          interval_index: 1,
          work_recovery_kind: null,
          segment_type: "recovery",
          ended_at: "2026-06-01T12:10:00.200Z",
        }),
        workIntervalRow(priorId, "2026-05-25T12:00:00.000Z"),
        workIntervalRow(priorId, "2026-05-25T12:05:00.000Z", { interval_index: 1 }),
      ],
    });
    await expect(repository.getCyclingProgression(selectedId)).resolves.toBeNull();
  });

  it("rejects cross-field work/recovery disagreement among merged peers", async () => {
    const conflictStart = "2026-06-01T12:05:00.000Z";
    const { repository } = setup({
      selected: rideRow({ member_activity_ids: [selectedId, memberId] }),
      intervalRows: [
        workIntervalRow(selectedId, window.startedAt),
        workIntervalRow(selectedId, conflictStart, { interval_index: 1 }),
        workIntervalRow(memberId, conflictStart, {
          interval_index: 1,
          work_recovery_kind: null,
          segment_type: "recovery",
        }),
        workIntervalRow(priorId, "2026-05-25T12:00:00.000Z"),
        workIntervalRow(priorId, "2026-05-25T12:05:00.000Z", { interval_index: 1 }),
      ],
    });
    await expect(repository.getCyclingProgression(selectedId)).resolves.toBeNull();
  });

  it("only lets a provider-recorded peer veto a cross-field classification dispute", async () => {
    const intervalRows = (sourceKind: "inferred" | "provider_recorded"): IntervalRow[] => [
      workIntervalRow(selectedId, window.startedAt),
      workIntervalRow(selectedId, "2026-06-01T12:05:00.000Z", { interval_index: 1 }),
      workIntervalRow(memberId, "2026-06-01T12:05:00.000Z", {
        interval_index: 1,
        source_kind: sourceKind,
        work_recovery_kind: null,
        segment_type: "recovery",
      }),
      workIntervalRow(priorId, "2026-05-25T12:00:00.000Z"),
      workIntervalRow(priorId, "2026-05-25T12:05:00.000Z", { interval_index: 1 }),
    ];
    const ride = rideRow({ member_activity_ids: [selectedId, memberId] });

    // With no disputed peer at all, the two-interval rides are comparable.
    const clean = setup({
      selected: ride,
      intervalRows: [
        workIntervalRow(selectedId, window.startedAt),
        workIntervalRow(selectedId, "2026-06-01T12:05:00.000Z", { interval_index: 1 }),
        workIntervalRow(priorId, "2026-05-25T12:00:00.000Z"),
        workIntervalRow(priorId, "2026-05-25T12:05:00.000Z", { interval_index: 1 }),
      ],
    });
    await expect(clean.repository.getCyclingProgression(selectedId)).resolves.toHaveProperty(
      "status",
      "ready",
    );

    // An inferred recovery peer at the same normalized bounds cannot veto the work class.
    const inferred = setup({ selected: ride, intervalRows: intervalRows("inferred") });
    await expect(inferred.repository.getCyclingProgression(selectedId)).resolves.toHaveProperty(
      "status",
      "ready",
    );

    // The very same peer vetoes once it is provider-recorded.
    const recorded = setup({ selected: ride, intervalRows: intervalRows("provider_recorded") });
    await expect(recorded.repository.getCyclingProgression(selectedId)).resolves.toBeNull();
  });

  it("accepts an adjacent recovery whose raw overlap rounds to a distinct boundary", async () => {
    // The recovery starts 400 ms before the work interval's rounded end, so raw bounds overlap,
    // but it normalizes into its own [300, 330] group instead of the work [0, 300] group.
    const { repository } = setup({
      intervalRows: [
        workIntervalRow(selectedId, window.startedAt),
        workIntervalRow(selectedId, "2026-06-01T12:04:59.600Z", {
          interval_index: 1,
          label: "Recovery 1",
          interval_type: "recovery",
          work_recovery_kind: "recovery",
          ended_at: "2026-06-01T12:05:30.000Z",
        }),
        workIntervalRow(priorId, "2026-05-25T12:00:00.000Z"),
      ],
    });

    const result = await repository.getCyclingProgression(selectedId);
    expect(result?.status).toBe("ready");
    expect(result?.rides[0]?.intervalCount).toBe(1);
  });

  it("accepts matching work peer classes that normalize into one group", async () => {
    const { repository } = setup({
      selected: rideRow({ member_activity_ids: [selectedId, memberId] }),
      intervalRows: [
        workIntervalRow(selectedId, window.startedAt),
        workIntervalRow(memberId, "2026-06-01T12:00:00.200Z", {
          source_provider: "garmin",
          source_activity_id: memberId,
          ended_at: "2026-06-01T12:05:00.200Z",
        }),
        workIntervalRow(priorId, "2026-05-25T12:00:00.000Z"),
      ],
    });

    await expect(repository.getCyclingProgression(selectedId)).resolves.toHaveProperty(
      "status",
      "ready",
    );
  });

  it("rejects a target power conflict even with another valid work group", async () => {
    const { repository } = setup({
      selected: rideRow({ member_activity_ids: [selectedId, memberId] }),
      intervalRows: [
        workIntervalRow(selectedId, window.startedAt),
        workIntervalRow(selectedId, "2026-06-01T12:05:00.000Z", {
          interval_index: 1,
          target_power_watts: 250,
        }),
        workIntervalRow(memberId, "2026-06-01T12:05:00.000Z", {
          interval_index: 1,
          source_provider: "garmin",
          source_activity_id: memberId,
          target_power_watts: 300,
        }),
        workIntervalRow(priorId, "2026-05-25T12:00:00.000Z"),
        workIntervalRow(priorId, "2026-05-25T12:05:00.000Z", { interval_index: 1 }),
      ],
    });

    await expect(repository.getCyclingProgression(selectedId)).resolves.toBeNull();
  });

  it("keeps adjacent work windows and rejects overlapping ones on both rides", async () => {
    const adjacent = setup({
      intervalRows: [
        workIntervalRow(selectedId, window.startedAt),
        workIntervalRow(selectedId, "2026-06-01T12:05:00.000Z", { interval_index: 1 }),
        workIntervalRow(priorId, "2026-05-25T12:00:00.000Z"),
        workIntervalRow(priorId, "2026-05-25T12:05:00.000Z", { interval_index: 1 }),
      ],
    });
    await expect(adjacent.repository.getCyclingProgression(selectedId)).resolves.toHaveProperty(
      "status",
      "ready",
    );

    const overlapping = setup({
      intervalRows: [
        workIntervalRow(selectedId, window.startedAt),
        workIntervalRow(selectedId, "2026-06-01T12:02:00.000Z", { interval_index: 1 }),
        workIntervalRow(priorId, "2026-05-25T12:00:00.000Z"),
        workIntervalRow(priorId, "2026-05-25T12:02:00.000Z", { interval_index: 1 }),
      ],
    });
    await expect(overlapping.repository.getCyclingProgression(selectedId)).resolves.toBeNull();
  });

  it("measures a work window by duration rather than its absolute start", async () => {
    const { repository } = setup({
      intervalRows: [
        workIntervalRow(selectedId, "2026-06-01T12:05:00.000Z"),
        workIntervalRow(priorId, "2026-05-25T12:00:00.000Z"),
      ],
    });

    await expect(repository.getCyclingProgression(selectedId)).resolves.toHaveProperty(
      "status",
      "ready",
    );
  });

  it("accepts work rows classified by segment_type or interval_type alone", async () => {
    const { repository } = setup({
      intervalRows: [
        workIntervalRow(selectedId, window.startedAt, {
          work_recovery_kind: null,
          segment_type: "work",
        }),
        workIntervalRow(priorId, "2026-05-25T12:00:00.000Z", {
          work_recovery_kind: null,
          interval_type: "work",
        }),
      ],
    });
    await expect(repository.getCyclingProgression(selectedId)).resolves.toHaveProperty(
      "status",
      "ready",
    );
  });

  it("rejects a work/recovery merge conflict even when a valid work interval also exists", async () => {
    const conflictStart = "2026-06-01T12:05:00.000Z";
    const { repository } = setup({
      selected: rideRow({ member_activity_ids: [selectedId, memberId] }),
      intervalRows: [
        workIntervalRow(selectedId, window.startedAt),
        workIntervalRow(selectedId, conflictStart, { interval_index: 1 }),
        workIntervalRow(memberId, conflictStart, {
          interval_index: 1,
          work_recovery_kind: "recovery",
        }),
        workIntervalRow(priorId, "2026-05-25T12:00:00.000Z"),
        workIntervalRow(priorId, "2026-05-25T12:05:00.000Z", { interval_index: 1 }),
      ],
    });
    await expect(repository.getCyclingProgression(selectedId)).resolves.toBeNull();
  });

  it("bails before ClickHouse reads when the selected ride has no work metadata", async () => {
    const { repository, query } = setup({
      intervalRows: [
        workIntervalRow(selectedId, window.startedAt, { work_recovery_kind: "recovery" }),
        workIntervalRow(priorId, "2026-05-25T12:00:00.000Z"),
      ],
    });
    await expect(repository.getCyclingProgression(selectedId)).resolves.toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it("returns null without loading power when the first candidate page is empty", async () => {
    const { repository, query } = setup({ candidates: [] });
    await expect(repository.getCyclingProgression(selectedId)).resolves.toBeNull();
    expect(query).not.toHaveBeenCalled();
  });

  it("filters direct power by authorized canonical/member pairs in the sample query", async () => {
    const { repository, query } = setup();
    await repository.getCyclingProgression(selectedId);
    const sampleCall = query.mock.calls.find(([, text]) => text.includes("activity_sensor_sample"));
    expect(sampleCall?.[1]).toMatch(/authorizedLinks:Array\(Tuple\(UUID, UUID\)\)/);
    expect(sampleCall?.[1]).toMatch(/tuple\(sensor\.activity_id/);
    expect(sampleCall?.[2]).toMatchObject({ authorizedLinks: expect.any(Array) });
  });

  it("returns a ready result with two source-backed rides", async () => {
    const { repository } = setup();
    const result = await repository.getCyclingProgression(selectedId);

    expect(result?.status).toBe("ready");
    expect(result?.basis).toBe("recorded_work_protocol");
    expect(result?.rides.map((ride) => ride.role)).toEqual(["selected", "comparison"]);
    expect(result?.rides.map((ride) => ride.activityId)).toEqual([selectedId, priorId]);
    expect(result?.rides.map((ride) => ride.date)).toEqual(["2026-06-01", "2026-05-25"]);
    expect(result?.rides.map((ride) => ride.sessionEffort)).toEqual([5, 5]);
    expect(result?.rides[0]?.intervals).toEqual([
      expect.objectContaining({
        index: 1,
        workDurationSeconds: 300,
        meanPowerWatts: 200,
        powerCoveragePct: 100,
        sourceProvider: "wahoo",
        sourceActivityId: selectedId,
      }),
    ]);
    expect(result?.rides[0]?.powerProvenance).toEqual({
      measurementKind: "direct",
      providers: ["wahoo"],
      devices: ["trainer"],
    });
    expect(result?.comparison).toEqual({
      intervalCount: 1,
      largestDurationDifferencePct: 0,
      largestMeanPowerDifferencePct: 0,
    });
  });

  it("continues past a full raw page whose rows all fail validation", async () => {
    // The raw rows pass SQL but fail the JavaScript validation gate. Keyset progress must use
    // the last raw row, and a full page with no validated rows must not end the search.
    const unusable = Array.from({ length: 8 }, (_, index) => {
      const id = `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
      const started = new Date(
        Date.parse("2026-05-31T12:00:00.000Z") - index * 60_000,
      ).toISOString();
      return rideRow({
        id,
        local_date: "2026-05-31",
        started_at: started,
        ended_at: new Date(Date.parse(started) + 600_000).toISOString(),
        perceived_exertion: null,
        member_activity_ids: [id],
      });
    });
    const { repository } = setup({ candidatePages: [unusable, [priorRideRow()]] });
    const result = await repository.getCyclingProgression(selectedId);
    expect(result?.status).toBe("ready");
    expect(result?.rides[1]?.activityId).toBe(priorId);
  });

  it("stops after a short raw page without fetching another", async () => {
    const older = priorRideRow({
      started_at: "2026-05-24T12:00:00.000Z",
      local_date: "2026-05-24",
    });
    const { repository, execute } = setup({
      candidatePages: [[priorRideRow()], [older]],
      candidatePower: 211,
    });
    await expect(repository.getCyclingProgression(selectedId)).resolves.toBeNull();
    const candidateCalls = execute.mock.calls.filter(([query]) =>
      collectSqlText(query).includes("cycling-progression:candidates"),
    );
    expect(candidateCalls).toHaveLength(1);
  });

  it("keeps a candidate with an exact workout identity matching the selected ride", async () => {
    const { repository } = setup({
      identities: [identityRow(selectedId, "workout-1"), identityRow(priorId, "workout-1")],
    });
    const result = await repository.getCyclingProgression(selectedId);
    expect(result?.basis).toBe("exact_workout_identity");
    expect(result?.rides[0]?.exactWorkoutIdentities).toEqual([
      { provider: "wahoo", value: "workout-1" },
    ]);
  });

  it("keeps different exact workout identities apart", async () => {
    const { repository } = setup({
      identities: [identityRow(selectedId, "workout-1"), identityRow(priorId, "workout-2")],
    });
    await expect(repository.getCyclingProgression(selectedId)).resolves.toBeNull();
  });

  it("rejects ambiguous exact workout identities", async () => {
    const { repository } = setup({
      identities: [identityRow(selectedId, "workout-1"), identityRow(selectedId, "workout-2")],
    });
    await expect(repository.getCyclingProgression(selectedId)).resolves.toBeNull();
  });

  it("compares exact workout identity lists only when both rides identify the workout", async () => {
    const mismatchedLengths = setup({
      identities: [
        identityRow(selectedId, "workout-1"),
        identityRow(priorId, "workout-1"),
        identityRow(priorId, "workout-2", "garmin"),
      ],
    });
    await expect(
      mismatchedLengths.repository.getCyclingProgression(selectedId),
    ).resolves.toBeNull();

    const partialMatch = setup({
      identities: [
        identityRow(selectedId, "workout-1"),
        identityRow(selectedId, "workout-2", "garmin"),
        identityRow(priorId, "workout-1"),
        identityRow(priorId, "workout-3", "garmin"),
      ],
    });
    await expect(partialMatch.repository.getCyclingProgression(selectedId)).resolves.toBeNull();

    const providerMismatch = setup({
      identities: [
        identityRow(selectedId, "workout-1"),
        identityRow(priorId, "workout-1", "garmin"),
      ],
    });
    await expect(providerMismatch.repository.getCyclingProgression(selectedId)).resolves.toBeNull();
  });

  it("ignores identity rows that are not exact, named workout identities", async () => {
    for (const overrides of [
      { kind: "other" },
      { strength: "fuzzy" },
      { namespace: "" },
      { value: "   " },
    ] satisfies Array<Partial<IdentityRow>>) {
      const { repository } = setup({
        identities: [
          identityRow(selectedId, "workout-1"),
          identityRow(priorId, "ignored", "wahoo", overrides),
        ],
      });
      await expect(repository.getCyclingProgression(selectedId)).resolves.toHaveProperty(
        "status",
        "ready",
      );
    }
  });

  it("sorts exact workout identities by provider then value", async () => {
    const { repository } = setup({
      identities: [
        identityRow(selectedId, "workout-a"),
        identityRow(selectedId, "workout-b", "garmin"),
        identityRow(priorId, "workout-a"),
        identityRow(priorId, "workout-b", "garmin"),
      ],
    });

    const result = await repository.getCyclingProgression(selectedId);
    expect(result?.rides[0]?.exactWorkoutIdentities).toEqual([
      { provider: "garmin", value: "workout-b" },
      { provider: "wahoo", value: "workout-a" },
    ]);
  });

  it("compares identity lists only when both rides identify the workout", async () => {
    for (const identities of [
      [identityRow(selectedId, "workout-1")],
      [identityRow(priorId, "workout-1")],
    ]) {
      const { repository } = setup({ identities });
      const result = await repository.getCyclingProgression(selectedId);
      expect(result?.basis).toBe("recorded_work_protocol");
    }
  });

  it("allows a five percent whole-ride duration difference", async () => {
    const atBoundary = setup({
      candidates: [priorRideRow({ ended_at: "2026-05-25T12:10:30.000Z" })],
    });
    await expect(atBoundary.repository.getCyclingProgression(selectedId)).resolves.toHaveProperty(
      "status",
      "ready",
    );

    const beyond = setup({
      candidates: [priorRideRow({ ended_at: "2026-05-25T12:11:00.000Z" })],
    });
    await expect(beyond.repository.getCyclingProgression(selectedId)).resolves.toBeNull();
  });

  it("allows a five percent work-duration difference and reports the largest", async () => {
    const atBoundary = setup({
      intervalRows: [
        workIntervalRow(selectedId, window.startedAt),
        workIntervalRow(priorId, "2026-05-25T12:00:00.000Z", {
          ended_at: "2026-05-25T12:05:15.000Z",
        }),
      ],
    });
    const boundaryResult = await atBoundary.repository.getCyclingProgression(selectedId);
    expect(boundaryResult?.comparison.largestDurationDifferencePct).toBeCloseTo(5, 5);

    const beyond = setup({
      intervalRows: [
        workIntervalRow(selectedId, window.startedAt),
        workIntervalRow(priorId, "2026-05-25T12:00:00.000Z", {
          ended_at: "2026-05-25T12:05:18.000Z",
        }),
      ],
    });
    await expect(beyond.repository.getCyclingProgression(selectedId)).resolves.toBeNull();
  });

  it("reports the largest work-duration difference across intervals", async () => {
    const { repository } = setup({
      intervalRows: [
        workIntervalRow(selectedId, window.startedAt),
        workIntervalRow(selectedId, "2026-06-01T12:05:00.000Z", { interval_index: 1 }),
        workIntervalRow(priorId, "2026-05-25T12:00:00.000Z", {
          ended_at: "2026-05-25T12:05:03.000Z",
        }),
        workIntervalRow(priorId, "2026-05-25T12:05:05.000Z", {
          interval_index: 1,
          ended_at: "2026-05-25T12:10:20.000Z",
        }),
      ],
    });

    const result = await repository.getCyclingProgression(selectedId);
    expect(result?.comparison.largestDurationDifferencePct).toBeCloseTo(5, 5);
  });

  it("yields null when the candidate has no moderate effort", async () => {
    const { repository } = setup({ candidates: [priorRideRow({ perceived_exertion: null })] });
    await expect(repository.getCyclingProgression(selectedId)).resolves.toBeNull();
  });

  it("yields null when intervals are inferred instead of provider recorded", async () => {
    const { repository } = setup({
      intervalRows: [
        workIntervalRow(selectedId, window.startedAt),
        workIntervalRow(priorId, "2026-05-25T12:00:00.000Z", { source_kind: "inferred" }),
      ],
    });
    await expect(repository.getCyclingProgression(selectedId)).resolves.toBeNull();
  });

  it("yields null when power is estimated", async () => {
    const { repository } = setup({ measurementKind: "estimated" });
    await expect(repository.getCyclingProgression(selectedId)).resolves.toBeNull();
  });

  it.each<{ kinds: MeasurementKind[]; eligible: boolean }>([
    { kinds: ["estimated"], eligible: false },
    { kinds: ["direct", "unknown"], eligible: false },
    { kinds: [], eligible: true },
  ])(
    "preserves gaps between direct samples for $kinds, eligible=$eligible",
    async ({ kinds, eligible }) => {
      const direct = sampleRows(selectedId);
      const interleaved = sampleRows(selectedId, kinds.length ? 200 : null, kinds);
      const { repository } = setup({
        selectedSamples: [
          ...direct.filter((row) => row.elapsed_seconds % 2 === 0),
          ...interleaved.filter((row) => row.elapsed_seconds % 2 === 1),
        ].sort((a, b) => a.elapsed_seconds - b.elapsed_seconds),
      });
      expect((await repository.getCyclingProgression(selectedId))?.status ?? null).toBe(
        eligible ? "ready" : null,
      );
    },
  );

  it("yields null when interval power coverage is sparse", async () => {
    const { repository } = setup({
      intervalRows: [
        workIntervalRow(selectedId, window.startedAt, {
          ended_at: new Date(Date.parse(window.startedAt) + 900_000).toISOString(),
        }),
        workIntervalRow(priorId, "2026-05-25T12:00:00.000Z"),
      ],
    });
    await expect(repository.getCyclingProgression(selectedId)).resolves.toBeNull();
  });

  it("requires the same number of provider-recorded work intervals", async () => {
    const { repository } = setup({
      intervalRows: [
        workIntervalRow(selectedId, window.startedAt),
        workIntervalRow(priorId, "2026-05-25T12:00:00.000Z"),
        workIntervalRow(priorId, "2026-05-25T12:05:00.000Z", { interval_index: 1 }),
      ],
    });
    await expect(repository.getCyclingProgression(selectedId)).resolves.toBeNull();
  });

  it("allows at most a five percent deviation in duration and mean power", async () => {
    const within = setup({ candidatePower: 210 });
    const withinResult = await within.repository.getCyclingProgression(selectedId);
    expect(withinResult?.comparison.largestMeanPowerDifferencePct).toBeCloseTo(5, 5);

    const outside = setup({ candidatePower: 211 });
    await expect(outside.repository.getCyclingProgression(selectedId)).resolves.toBeNull();
  });

  it("compares the raw mean and keeps it in the contract for display rounding", async () => {
    // 210.04 W is 5.02% above 200 W: it must be rejected before any rounding.
    const beyond = setup({ candidatePower: 210.04 });
    await expect(beyond.repository.getCyclingProgression(selectedId)).resolves.toBeNull();

    // The unrounded mean survives into the contract; both clients round it for display.
    const raw = setup({ candidatePower: 208.4 });
    const result = await raw.repository.getCyclingProgression(selectedId);
    expect(result?.rides[1]?.intervals[0]?.meanPowerWatts).toBeCloseTo(208.4, 5);

    // A positive mean below half a watt stays positive instead of rounding to zero, which
    // would violate the contract's positive-number schema.
    const subWatt = setup({ selectedPower: 0.4, candidatePower: 0.4 });
    const small = await subWatt.repository.getCyclingProgression(selectedId);
    expect(small?.status).toBe("ready");
    expect(small?.rides[0]?.intervals[0]?.meanPowerWatts).toBeCloseTo(0.4, 5);
  });

  it("rejects overlapping recorded work intervals", async () => {
    const { repository } = setup({
      intervalRows: [
        workIntervalRow(selectedId, window.startedAt),
        workIntervalRow(selectedId, "2026-06-01T12:02:00.000Z", { interval_index: 1 }),
        workIntervalRow(priorId, "2026-05-25T12:00:00.000Z"),
      ],
    });
    await expect(repository.getCyclingProgression(selectedId)).resolves.toBeNull();
  });

  it("rejects identical work when the whole-ride duration is not comparable", async () => {
    // Same three-hundred-second work interval and power, but a sixty-minute ride against a
    // ten-minute selected ride: the imported effort describes each whole ride, not just the work.
    const longer = setup({
      candidates: [priorRideRow({ ended_at: "2026-05-25T13:00:00.000Z" })],
    });
    await expect(longer.repository.getCyclingProgression(selectedId)).resolves.toBeNull();

    // A canonical window beyond the twelve-hour bound is not loaded at all.
    const unbounded = setup({
      candidates: [priorRideRow({ ended_at: "2026-05-26T00:30:00.000Z" })],
    });
    await expect(unbounded.repository.getCyclingProgression(selectedId)).resolves.toBeNull();
  });

  it("falls back to the next most recent candidate when the newest is incomparable", async () => {
    const olderId = "00000000-0000-4000-8000-000000000004";
    const { repository } = setup({
      candidates: [
        priorRideRow({ perceived_exertion: 8 }),
        priorRideRow({
          id: olderId,
          local_date: "2026-05-20",
          started_at: "2026-05-20T12:00:00.000Z",
          member_activity_ids: [olderId],
        }),
      ],
      intervalRows: [
        workIntervalRow(selectedId, window.startedAt),
        workIntervalRow(olderId, "2026-05-20T12:00:00.000Z"),
      ],
      measurementKind: "direct",
    });
    const result = await repository.getCyclingProgression(selectedId);
    expect(result?.rides[1]?.activityId).toBe(olderId);
  });
});
