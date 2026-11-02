import { describe, expect, it, vi } from "vitest";
import {
  CyclingThresholdRepository,
  cyclingThresholdEvidenceFromMetrics,
} from "./cycling-threshold-repository.ts";

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
    query.mockResolvedValue([
      { ...row, event_at: "2026-05-31T00:00:00Z", activity_id: null, eftp: 244 },
    ]);
    const second = await repository.listHistory({
      startDate: "2026-05-01",
      endDate: "2026-08-01",
      cursor: first.next_cursor,
      limit: 1,
    });
    expect(query).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({
        cursorAt: row.event_at,
        cursorActivityId: activityId,
        pageLimit: 2,
      }),
    );
    expect(second.items[0]).toMatchObject({
      activity_id: null,
      value: 244,
      event_at: "2026-05-31T00:00:00Z",
    });
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

const historyInput = { startDate: "2026-05-01", endDate: "2026-08-01", cursor: null, limit: 1 };
async function historyCursor() {
  const query = vi.fn().mockResolvedValue([row, { ...row, activity_id: null }]);
  const page = await new CyclingThresholdRepository({ query }, userId, "UTC").listHistory(
    historyInput,
  );
  if (!page.next_cursor) throw new Error("Expected a continuation cursor");
  return page.next_cursor;
}
function changeCursor(cursor: string, changes: Record<string, unknown>) {
  return Buffer.from(
    JSON.stringify({
      ...JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
      ...changes,
    }),
  ).toString("base64url");
}

describe("CyclingThresholdRepository evidence and query contracts", () => {
  it("retains all effective evidence fields and binds the current user", async () => {
    const query = vi.fn().mockResolvedValue([row]);
    const result = await new CyclingThresholdRepository({ query }, userId, "UTC").getCurrent();
    expect(result).toMatchObject({
      value: 245,
      unit: "watt",
      event_at: row.event_at,
      evidence_activity_id: activityId,
      evidence_at: row.evidence_at,
      evidence_duration_seconds: 1200,
      evidence_power: 260,
      model_version: "reference-v1",
      unavailable_reason: null,
    });
    expect(query).toHaveBeenCalledWith(expect.anything(), expect.any(String), { userId });
  });
  it("binds an as-of timestamp and the caller timezone", async () => {
    const query = vi.fn().mockResolvedValue([]);
    const result = await new CyclingThresholdRepository(
      { query },
      userId,
      "America/Los_Angeles",
    ).getAsOf("2026-06-01T12:00:00Z");
    expect(query).toHaveBeenCalledWith(expect.anything(), expect.any(String), {
      userId,
      asOf: "2026-06-01T12:00:00Z",
      timezone: "America/Los_Angeles",
    });
    expect(result).toMatchObject({
      value: null,
      event_at: null,
      evidence_activity_id: null,
      evidence_at: null,
      evidence_duration_seconds: null,
      evidence_power: null,
      model_version: null,
    });
  });
  it("retains metadata on an effective event without a threshold", async () => {
    const query = vi.fn().mockResolvedValue([
      {
        ...row,
        eftp: null,
        evidence_activity_id: null,
        evidence_at: null,
        evidence_duration_seconds: null,
        evidence_power: null,
      },
    ]);
    const result = await new CyclingThresholdRepository({ query }, userId, "UTC").getCurrent();
    expect(result).toMatchObject({
      value: null,
      event_at: row.event_at,
      evidence_at: null,
      evidence_power: null,
      model_version: "reference-v1",
      unavailable_reason: expect.any(String),
    });
  });
  it("does not query for an empty activity batch", async () => {
    const query = vi.fn().mockRejectedValue(new Error("Unexpected query"));
    expect(
      await new CyclingThresholdRepository({ query }, userId, "UTC").getForActivities([]),
    ).toEqual(new Map());
    expect(query).not.toHaveBeenCalled();
  });
  it("binds activity IDs to their owner and preserves independent null and zero metrics", async () => {
    const metrics = {
      ...row,
      started_at: row.event_at,
      normalized_power: 0,
      intensity_factor: 0,
      power_tss: 0,
      evidence_power: 0,
    };
    const query = vi.fn().mockResolvedValue([metrics]);
    expect(
      await new CyclingThresholdRepository({ query }, userId, "UTC").getForActivities([activityId]),
    ).toEqual(new Map([[activityId, metrics]]));
    expect(query).toHaveBeenCalledWith(expect.anything(), expect.any(String), {
      userId,
      activityIds: [activityId],
    });
  });
  it("binds the same access window on current, as-of, activity and history reads", async () => {
    const query = vi.fn().mockResolvedValue([]);
    const accessWindow = {
      kind: "limited",
      paid: false,
      reason: "free_recent_week",
      startDate: "2026-05-25T00:00:00Z",
      endDateExclusive: "2026-06-02T00:00:00Z",
    } as const;
    const repository = new CyclingThresholdRepository({ query }, userId, "UTC", accessWindow);
    await repository.getCurrent();
    await repository.getAsOf("2026-06-01");
    await repository.getForActivities([activityId]);
    await repository.listHistory(historyInput);
    expect(query).toHaveBeenCalledTimes(4);
    for (const call of query.mock.calls)
      expect(call[2]).toMatchObject({
        userId,
        accessStartDate: accessWindow.startDate,
        accessEndDateExclusive: accessWindow.endDateExclusive,
      });
  });
  it("propagates source failures without returning missing-evidence success", async () => {
    const failure = new Error("Canonical projection unavailable");
    const query = vi.fn().mockRejectedValue(failure);
    const repository = new CyclingThresholdRepository({ query }, userId, "UTC");
    await expect(repository.getCurrent()).rejects.toBe(failure);
    await expect(repository.getAsOf("2026-06-01")).rejects.toBe(failure);
    await expect(repository.getForActivities([activityId])).rejects.toBe(failure);
    await expect(repository.listHistory(historyInput)).rejects.toBe(failure);
  });
});

describe("cyclingThresholdEvidenceFromMetrics", () => {
  it("uses the activity-effective timestamp and preserves zero evidence power", () => {
    const started_at = "2026-06-02T08:00:00Z";
    expect(
      cyclingThresholdEvidenceFromMetrics({
        ...row,
        started_at,
        normalized_power: 0,
        power_tss: 0,
        intensity_factor: 0,
        evidence_power: 0,
      }),
    ).toMatchObject({
      value: 245,
      event_at: started_at,
      evidence_at: row.evidence_at,
      evidence_power: 0,
      unavailable_reason: null,
    });
  });
  it("returns explicit unavailable evidence when the activity has no canonical metrics", () => {
    expect(cyclingThresholdEvidenceFromMetrics(null)).toMatchObject({
      value: null,
      event_at: null,
      evidence_activity_id: null,
      evidence_at: null,
      evidence_duration_seconds: null,
      evidence_power: null,
      model_version: null,
      unavailable_reason: expect.any(String),
    });
  });
});

describe("CyclingThresholdRepository continuation contracts", () => {
  it.each([{ rows: [] }, { rows: [row] }])(
    "ends history when the returned page has no look-ahead row: %j",
    async ({ rows }) => {
      const query = vi.fn().mockResolvedValue(rows);
      expect(
        await new CyclingThresholdRepository({ query }, userId, "UTC").listHistory(historyInput),
      ).toMatchObject({
        items: rows.map((r) =>
          expect.objectContaining({ value: r.eftp, activity_id: r.activity_id }),
        ),
        next_cursor: null,
      });
      expect(query).toHaveBeenCalledWith(expect.anything(), expect.any(String), {
        userId,
        timezone: "UTC",
        startDate: historyInput.startDate,
        endDate: historyInput.endDate,
        pageLimit: 2,
      });
    },
  );
  it("returns only the requested items and resumes after a decay event", async () => {
    const decay = { ...row, activity_id: null, event_at: "2026-06-02T00:00:00Z" };
    const query = vi.fn().mockResolvedValue([decay, row]);
    const repository = new CyclingThresholdRepository({ query }, userId, "UTC");
    const page = await repository.listHistory(historyInput);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ event_at: decay.event_at, activity_id: null });
    expect(page.next_cursor).toEqual(expect.any(String));
    query.mockResolvedValue([row]);
    const last = await repository.listHistory({ ...historyInput, cursor: page.next_cursor });
    expect(last.next_cursor).toBeNull();
    expect(query).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.any(String),
      expect.objectContaining({ cursorAt: decay.event_at, cursorActivityId: "", pageLimit: 2 }),
    );
  });
  it.each(["user", "timezone", "start", "end"])(
    "rejects cursor reuse after changing %s",
    async (change) => {
      const cursor = await historyCursor();
      const query = vi.fn();
      const repository = new CyclingThresholdRepository(
        { query },
        change === "user" ? activityId : userId,
        change === "timezone" ? "America/Los_Angeles" : "UTC",
      );
      await expect(
        repository.listHistory({
          ...historyInput,
          cursor,
          startDate: change === "start" ? "2026-05-02" : historyInput.startDate,
          endDate: change === "end" ? "2026-08-02" : historyInput.endDate,
        }),
      ).rejects.toThrow("Cursor does not match this request");
      expect(query).not.toHaveBeenCalled();
    },
  );
  it.each([
    "!",
    "%%",
    Buffer.from("not JSON").toString("base64url"),
    Buffer.from("null").toString("base64url"),
    Buffer.from('{"version":2}').toString("base64url"),
  ])("rejects malformed cursor %s before querying", async (cursor) => {
    const query = vi.fn();
    await expect(
      new CyclingThresholdRepository({ query }, userId, "UTC").listHistory({
        ...historyInput,
        cursor,
      }),
    ).rejects.toThrow("Invalid analytical cursor");
    expect(query).not.toHaveBeenCalled();
  });
  it.each([{ version: 1 }, { extra: "field" }, { userId: "not-a-uuid" }, { activityId: null }])(
    "rejects cursor schema violation %j",
    async (changes) => {
      const query = vi.fn();
      await expect(
        new CyclingThresholdRepository({ query }, userId, "UTC").listHistory({
          ...historyInput,
          cursor: changeCursor(await historyCursor(), changes),
        }),
      ).rejects.toThrow("Invalid analytical cursor");
      expect(query).not.toHaveBeenCalled();
    },
  );
  it("rejects alternative encodings of otherwise valid cursor JSON", async () => {
    let valid = await historyCursor();
    if (Buffer.from(valid, "base64url").length % 3 === 0)
      valid = Buffer.from(`${Buffer.from(valid, "base64url").toString("utf8")} `).toString(
        "base64url",
      );
    const decoded = Buffer.from(valid, "base64url");
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const alternate = [...alphabet]
      .map((char) => valid.slice(0, -1) + char)
      .find(
        (candidate) => candidate !== valid && Buffer.from(candidate, "base64url").equals(decoded),
      );
    if (!alternate) throw new Error("Fixture must include unused base64 padding bits");
    for (const cursor of [`!${valid}`, `${valid}!`, `${valid}=`, alternate]) {
      const query = vi.fn();
      await expect(
        new CyclingThresholdRepository({ query }, userId, "UTC").listHistory({
          ...historyInput,
          cursor,
        }),
      ).rejects.toThrow("Invalid analytical cursor");
      expect(query).not.toHaveBeenCalled();
    }
  });
  it("accepts the 2048-byte decoded boundary and rejects oversized cursors", async () => {
    const original = await historyCursor();
    const decoded = Buffer.from(original, "base64url").toString("utf8");
    const baseSize = Buffer.byteLength(decoded);
    for (const size of [2048, 2049]) {
      const cursor = Buffer.from(decoded + " ".repeat(size - baseSize)).toString("base64url");
      const query = vi.fn().mockResolvedValue([]);
      const result = new CyclingThresholdRepository({ query }, userId, "UTC").listHistory({
        ...historyInput,
        cursor,
      });
      if (size === 2048) {
        await expect(result).resolves.toMatchObject({ items: [], next_cursor: null });
        expect(query).toHaveBeenCalledOnce();
      } else {
        await expect(result).rejects.toThrow("Invalid analytical cursor");
        expect(query).not.toHaveBeenCalled();
      }
    }
  });
});
