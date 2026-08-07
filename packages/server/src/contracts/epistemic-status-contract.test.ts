import { EPISTEMIC_STATUS, EPISTEMIC_STATUS_KINDS } from "@dofek/scoring/epistemic-status";
import { describe, expect, it } from "vitest";
import { epistemicStatusSchema } from "./epistemic-status-contract.ts";

describe("epistemic status contract", () => {
  it("accepts every shared status with its canonical label", () => {
    for (const kind of EPISTEMIC_STATUS_KINDS) {
      expect(epistemicStatusSchema.parse(EPISTEMIC_STATUS[kind])).toEqual(EPISTEMIC_STATUS[kind]);
    }
  });

  it("rejects a status whose label does not match its kind", () => {
    expect(epistemicStatusSchema.safeParse({ kind: "estimated", label: "Observed" }).success).toBe(
      false,
    );
  });
});
