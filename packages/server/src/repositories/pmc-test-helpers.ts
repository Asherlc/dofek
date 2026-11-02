export function pmcThresholdHistoryRows(currentEftp: number | null) {
  return currentEftp === null
    ? []
    : [
        {
          event_at: "2026-06-01T12:00:00.000000Z",
          activity_id: null,
          eftp: currentEftp,
          evidence_activity_id: "00000000-0000-4000-8000-000000000001",
          evidence_at: "2026-06-01T10:00:00.000000Z",
          evidence_duration_seconds: 1200,
          evidence_power: 280,
          model_version: "test-cycling-model",
        },
      ];
}
