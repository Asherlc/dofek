import { afterEach, describe, expect, it, vi } from "vitest";
import { createFixtureDates } from "./_fixture-dates";

describe("createFixtureDates", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps every derived date anchored when the system clock crosses midnight", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 27, 23, 59, 59));
    const dates = createFixtureDates(new Date());

    vi.setSystemTime(new Date(2026, 6, 28, 0, 0, 1));

    expect(dates.date()).toBe("2026-07-27");
    expect(dates.date(-1)).toBe("2026-07-26");
    expect(dates.weekStart()).toBe("2026-07-27");
    expect(dates.weekStart(-1)).toBe("2026-07-20");
  });
});
