import { describe, expect, it } from "vitest";
import {
  hasSyncStepAdmissionClaimed,
  isInsideSyncStepAdmission,
  markSyncStepAdmissionClaimed,
  runWithSyncStepAdmission,
} from "./sync-step-admission-context.ts";

describe("sync-step-admission-context", () => {
  it("tracks admission state within a sync step scope", () => {
    expect(isInsideSyncStepAdmission()).toBe(false);
    expect(hasSyncStepAdmissionClaimed()).toBe(false);

    runWithSyncStepAdmission(() => {
      expect(isInsideSyncStepAdmission()).toBe(true);
      expect(hasSyncStepAdmissionClaimed()).toBe(false);
      markSyncStepAdmissionClaimed();
      expect(hasSyncStepAdmissionClaimed()).toBe(true);
    });

    expect(isInsideSyncStepAdmission()).toBe(false);
    expect(hasSyncStepAdmissionClaimed()).toBe(false);
  });

  it("resets admission state for each sync step scope", () => {
    runWithSyncStepAdmission(() => {
      markSyncStepAdmissionClaimed();
      expect(hasSyncStepAdmissionClaimed()).toBe(true);
    });

    runWithSyncStepAdmission(() => {
      expect(hasSyncStepAdmissionClaimed()).toBe(false);
    });
  });
});
