import { describe, expect, it, vi } from "vitest";
import { backfillClimbingAttemptCount } from "./climbing-attempt-count-backfill.ts";

describe("backfillClimbingAttemptCount", () => {
  it("counts eligible Kaya entries without updating during a dry run", async () => {
    const execute = vi.fn().mockResolvedValue([{ count: 3 }]);

    await expect(backfillClimbingAttemptCount({ execute }, false)).resolves.toBe(3);

    const query = JSON.stringify(execute.mock.calls[0]?.[0]);
    expect(query).toContain("SELECT COUNT(*)::int AS count");
    expect(query).not.toContain("UPDATE fitness.climbing_entry");
    expect(query).toContain("source_name = 'Kaya'");
  });

  it("updates canonical attempt counts when execution is explicit", async () => {
    const execute = vi.fn().mockResolvedValue([{ count: 2 }]);

    await expect(backfillClimbingAttemptCount({ execute }, true)).resolves.toBe(2);

    const query = JSON.stringify(execute.mock.calls[0]?.[0]);
    expect(query).toContain("UPDATE fitness.climbing_entry");
    expect(query).toContain("SET attempt_count = (raw->>'attempts')::int");
  });

  it("rejects a missing count row", async () => {
    const execute = vi.fn().mockResolvedValue([]);

    await expect(backfillClimbingAttemptCount({ execute }, false)).rejects.toThrow(
      "Expected one backfill count row",
    );
  });
});
