import { randomUUID } from "node:crypto";

export function runningRevisionFixture(userId: string) {
  const records = Array.from({ length: 101 }, (_, index) => ({
    member: randomUUID(),
    group: randomUUID(),
    nextMember: randomUUID(),
    nextGroup: randomUUID(),
    workout: randomUUID(),
    nextWorkout: randomUUID(),
    rawId: randomUUID(),
    sync: `revision-${index}`,
  }));
  const foreignUserId = randomUUID();
  const activityRows = (next: boolean) =>
    records.map((record) => ({
      id: next ? record.nextMember : record.member,
      group_id: next ? record.nextGroup : record.group,
      provider_id: "apple_health",
      user_id: userId,
      external_id: `hk:workout:${next ? record.nextWorkout : record.workout}`,
      canonical_type: "running",
      provider_type: "running",
      started_at: "2026-09-01 08:00:00",
      ended_at: "2026-09-01 08:10:00",
      source_name: "Watch",
      raw: JSON.stringify({
        metadata: {
          HKMetadataKeySyncIdentifier: record.sync,
          HKMetadataKeySyncVersion: next ? 2 : 1,
        },
      }),
      local_time_source: "unknown",
      _peerdb_synced_at: "2026-09-02 17:00:00",
      _peerdb_version: next ? 2 : 1,
      created_at: next ? "2026-09-02 17:00:00" : "2026-09-01 17:00:00",
    }));
  const initialActivityRows = activityRows(false);
  const foreignActivity = initialActivityRows[0];
  if (!foreignActivity) throw new Error("Running revision fixture requires an initial activity");
  const stepRows = (next: boolean) =>
    records.map((record) => ({
      id: record.rawId,
      user_id: userId,
      provider_id: "apple_health",
      channel: "step_count",
      scalar: next ? 180 : 150,
      recorded_at: "2026-09-01 08:00:00",
      device_id: "Watch",
      external_id: record.rawId,
      metadata: JSON.stringify({
        interval_end: "2026-09-01T08:01:00Z",
        source_bundle: "com.watch",
        workout_uuids: [next ? record.nextWorkout : record.workout],
      }),
      version: next ? 2 : 1,
      ingested_at: next ? "2026-09-02 17:00:02" : "2026-09-02 17:00:01",
    }));
  return {
    records,
    foreignUserId,
    initialActivityRows: [
      ...initialActivityRows,
      {
        ...foreignActivity,
        id: randomUUID(),
        group_id: randomUUID(),
        user_id: foreignUserId,
      },
    ],
    revisedActivityRows: activityRows(true),
    initialStepRows: stepRows(false),
    revisedStepRows: stepRows(true),
  };
}
