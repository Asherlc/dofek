import { describe, expect, it } from "vitest";
import {
  importTypeFromJobData,
  isJobDataForUser,
  providerIdForImportType,
  providerIdFromSyncJobData,
} from "./sync-helpers.ts";

describe("providerIdForImportType", () => {
  it("maps known import types to provider ids", () => {
    expect(providerIdForImportType("apple-health")).toBe("apple_health");
    expect(providerIdForImportType("strong-csv")).toBe("strong-csv");
    expect(providerIdForImportType("cronometer-csv")).toBe("cronometer-csv");
    expect(providerIdForImportType("kaya-export")).toBe("kaya-export");
    expect(providerIdForImportType("zos-app")).toBe("zos-app");
    expect(providerIdForImportType("garmin-dump")).toBe("garmin-dump");
    expect(providerIdForImportType("fit-file")).toBe("fit-file");
  });

  it("returns undefined for unknown import types", () => {
    expect(providerIdForImportType("unknown-import-type")).toBeUndefined();
  });
});

describe("isJobDataForUser", () => {
  it("returns false for null, primitives, and objects without userId", () => {
    expect(isJobDataForUser(null, "user-1")).toBe(false);
    expect(isJobDataForUser("invalid", "user-1")).toBe(false);
    expect(isJobDataForUser({ providerId: "garmin" }, "user-1")).toBe(false);
  });

  it("returns false for other users and true for matching users", () => {
    expect(isJobDataForUser({ userId: "other-user" }, "user-1")).toBe(false);
    expect(isJobDataForUser({ userId: "user-1" }, "user-1")).toBe(true);
  });
});

describe("importTypeFromJobData", () => {
  it("returns undefined for malformed job data", () => {
    expect(importTypeFromJobData(null)).toBeUndefined();
    expect(importTypeFromJobData("invalid")).toBeUndefined();
    expect(importTypeFromJobData({ userId: "user-1" })).toBeUndefined();
    expect(importTypeFromJobData({ userId: "user-1", importType: 123 })).toBeUndefined();
  });

  it("returns string import types", () => {
    expect(importTypeFromJobData({ importType: "apple-health" })).toBe("apple-health");
  });
});

describe("providerIdFromSyncJobData", () => {
  const knownProviderIds = new Set(["garmin", "whoop"]);

  it("falls back to the queue provider id for missing or invalid payload values", () => {
    expect(providerIdFromSyncJobData({}, "garmin", knownProviderIds)).toBe("garmin");
    expect(providerIdFromSyncJobData({ providerId: null }, "garmin", knownProviderIds)).toBe(
      "garmin",
    );
    expect(providerIdFromSyncJobData({ providerId: "" }, "garmin", knownProviderIds)).toBe(
      "garmin",
    );
    expect(providerIdFromSyncJobData({ providerId: 123 }, "garmin", knownProviderIds)).toBe(
      "garmin",
    );
    expect(providerIdFromSyncJobData({}, "strava", knownProviderIds)).toBeUndefined();
  });

  it("returns known payload provider ids and ignores unknown stale values", () => {
    expect(providerIdFromSyncJobData({ providerId: "garmin" }, "whoop", knownProviderIds)).toBe(
      "garmin",
    );
    expect(
      providerIdFromSyncJobData({ providerId: "stale-unknown" }, "garmin", knownProviderIds),
    ).toBe("garmin");
    expect(
      providerIdFromSyncJobData({ providerId: "stale-unknown" }, "strava", knownProviderIds),
    ).toBeUndefined();
  });
});
