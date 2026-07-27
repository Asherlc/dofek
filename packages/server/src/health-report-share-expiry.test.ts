import { describe, expect, it } from "vitest";
import {
  DEFAULT_HEALTH_REPORT_SHARE_EXPIRY_DAYS,
  HEALTH_REPORT_SHARE_EXPIRY_OPTIONS,
} from "./health-report-share-expiry.ts";

describe("health-report-share-expiry", () => {
  it("exposes the shared client durations within the server 1–90 day contract", () => {
    expect(HEALTH_REPORT_SHARE_EXPIRY_OPTIONS).toEqual([7, 30, 90]);
    expect(DEFAULT_HEALTH_REPORT_SHARE_EXPIRY_DAYS).toBe(7);
    expect(HEALTH_REPORT_SHARE_EXPIRY_OPTIONS).toContain(DEFAULT_HEALTH_REPORT_SHARE_EXPIRY_DAYS);
    for (const days of HEALTH_REPORT_SHARE_EXPIRY_OPTIONS) {
      expect(days).toBeGreaterThanOrEqual(1);
      expect(days).toBeLessThanOrEqual(90);
    }
  });
});
