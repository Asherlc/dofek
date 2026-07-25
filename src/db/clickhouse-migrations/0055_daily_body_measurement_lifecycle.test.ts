import { describe, expect, it } from "vitest";
import { createMigration } from "./0055_daily_body_measurement_lifecycle.ts";

describe("0055_daily_body_measurement_lifecycle", () => {
  it("adds lifecycle and source-watermark columns to the existing serving table", () => {
    expect(createMigration()).toEqual({
      id: "0055_daily_body_measurement_lifecycle",
      statements: [
        `ALTER TABLE analytics.daily_body_measurement
        ADD COLUMN IF NOT EXISTS is_deleted UInt8 DEFAULT 0 AFTER body_fat_pct`,
        `ALTER TABLE analytics.daily_body_measurement
        ADD COLUMN IF NOT EXISTS source_synced_at DateTime64(9, 'UTC')
        DEFAULT toDateTime64('1970-01-01 00:00:00', 9, 'UTC') AFTER is_deleted`,
      ],
    });
  });
});
