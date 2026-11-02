import { describe, expect, it, vi } from "vitest";
import { CyclingThresholdRepository } from "./cycling-threshold-repository.ts";

const userId = "00000000-0000-4000-8000-000000000001";
const activityId = "00000000-0000-4000-8000-000000000101";
const row = {
  event_at: "2026-06-01T07:00:00.000Z",
  activity_id: activityId,
  eftp: 245,
  evidence_activity_id: activityId,
  evidence_at: "2026-06-01T07:00:00.000Z",
  evidence_duration_seconds: 1200,
  evidence_power: 260,
  model_version: "reference-v1",
};

describe("CyclingThresholdRepository", () => {
  it("maps current computed evidence with its source effort", async () => {
    const query = vi.fn().mockResolvedValue([row]);
    const result = await new CyclingThresholdRepository({ query }, userId, "UTC").getCurrent();
    expect(result.uncertainty).toEqual({
      kind: "not_quantifiable",
      watts: null,
      reason:
        "Reference-curve estimate; individual physiological FTP uncertainty has not been quantified.",
    });
    expect(result).toMatchObject({
      value: 245,
      method: "computed_eftp",
      evidence_activity_id: activityId,
      evidence_duration_seconds: 1200,
      model_version: "reference-v1",
      unavailable_reason: null,
    });
  });

  it("reports insufficient power evidence explicitly", async () => {
    const query = vi.fn().mockResolvedValue([]);
    const result = await new CyclingThresholdRepository({ query }, userId, "UTC").getAsOf(
      "2026-06-01T12:00:00Z",
    );
    expect(result.value).toBeNull();
    expect(result.unavailable_reason).toContain("qualifying cycling power evidence");
  });

  it("maps canonical power metrics in one activity batch", async () => {
    const query = vi.fn().mockResolvedValue([
      {
        ...row,
        started_at: row.event_at,
        normalized_power: 240,
        intensity_factor: 240 / 245,
        power_tss: 80,
      },
    ]);
    const result = await new CyclingThresholdRepository({ query }, userId, "UTC").getForActivities([
      activityId,
    ]);
    expect(result.get(activityId)).toMatchObject({
      eftp: 245,
      normalized_power: 240,
      power_tss: 80,
    });
  });

  it("returns decay events and activity evidence in chronological history pages", async () => {
    const query = vi
      .fn()
      .mockResolvedValue([
        row,
        { ...row, event_at: "2026-05-31T00:00:00Z", activity_id: null, eftp: 244 },
      ]);
    const repository = new CyclingThresholdRepository({ query }, userId, "UTC");
    const first = await repository.listHistory({
      startDate: "2026-05-01",
      endDate: "2026-08-01",
      cursor: null,
      limit: 1,
    });
    expect(first.items[0]).toMatchObject({
      value: 245,
      evidence_kind: "computed",
      historical_validity: "effective_dated",
    });
    expect(first.next_cursor).toEqual(expect.any(String));
    query.mockResolvedValue([{ ...row, activity_id: null, eftp: 244 }]);
    const second = await repository.listHistory({
      startDate: "2026-05-01",
      endDate: "2026-08-01",
      cursor: first.next_cursor,
      limit: 1,
    });
    expect(second.items[0]).toMatchObject({ activity_id: null, value: 244 });
  });

  it("rejects a cursor reused with changed filters before querying", async () => {
    const query = vi.fn().mockResolvedValue([row, { ...row, activity_id: null }]);
    const repository = new CyclingThresholdRepository({ query }, userId, "UTC");
    const first = await repository.listHistory({
      startDate: "2026-05-01",
      endDate: "2026-08-01",
      cursor: null,
      limit: 1,
    });
    await expect(
      repository.listHistory({
        startDate: "2026-05-01",
        endDate: "2026-08-02",
        cursor: first.next_cursor,
        limit: 1,
      }),
    ).rejects.toThrow("Cursor does not match this request");
    expect(query).toHaveBeenCalledTimes(1);
  });
});
