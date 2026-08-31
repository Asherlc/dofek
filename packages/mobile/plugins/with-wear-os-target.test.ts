import { describe, expect, it } from "vitest";
import { appendWearTargetToSettings } from "./with-wear-os-target";

describe("appendWearTargetToSettings", () => {
  it("includes DofekWear exactly once", () => {
    const first = appendWearTargetToSettings('rootProject.name = "Dofek"\n');

    expect(first).toContain('include(":DofekWear")');
    expect(appendWearTargetToSettings(first).match(/DofekWear/g)).toHaveLength(1);
  });
});
