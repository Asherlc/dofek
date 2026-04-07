import { describe, expect, it } from "vitest";
import { sleepListRowSchema } from "../repositories/sleep-repository.ts";

describe("sleepListRowSchema", () => {
  it("parses a row with ISO-formatted started_at", () => {
    const row = {
      started_at: "2026-03-19T06:26:28Z",
      duration_minutes: 474,
      deep_minutes: 0,
      rem_minutes: 0,
      light_minutes: 460,
      awake_minutes: 20,
      efficiency_pct: null,
    };
    const parsed = sleepListRowSchema.parse(row);
    expect(parsed.started_at).toBe("2026-03-19T06:26:28Z");
    expect(parsed.duration_minutes).toBe(474);
    expect(parsed.light_minutes).toBe(460);
  });

  it("coerces string numbers from pg driver", () => {
    const row = {
      started_at: "2026-03-19T06:26:28Z",
      duration_minutes: "474",
      deep_minutes: "0",
      rem_minutes: "0",
      light_minutes: "460",
      awake_minutes: "20",
      efficiency_pct: "95.5",
    };
    const parsed = sleepListRowSchema.parse(row);
    expect(parsed.duration_minutes).toBe(474);
    expect(parsed.efficiency_pct).toBe(95.5);
  });

  it("handles null stage minutes", () => {
    const row = {
      started_at: "2026-03-11T06:17:04Z",
      duration_minutes: 492,
      deep_minutes: null,
      rem_minutes: null,
      light_minutes: null,
      awake_minutes: 27,
      efficiency_pct: 0,
    };
    const parsed = sleepListRowSchema.parse(row);
    expect(parsed.deep_minutes).toBeNull();
    expect(parsed.awake_minutes).toBe(27);
  });

  it("produces timestamps parseable by new Date() in strict engines", () => {
    const row = {
      started_at: "2026-03-19T06:26:28Z",
      duration_minutes: 474,
      deep_minutes: 0,
      rem_minutes: 0,
      light_minutes: 460,
      awake_minutes: 20,
      efficiency_pct: null,
    };
    const parsed = sleepListRowSchema.parse(row);
    const date = new Date(parsed.started_at);
    expect(date.getTime()).not.toBeNaN();
  });
});
