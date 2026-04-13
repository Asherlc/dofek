import { describe, expect, it } from "vitest";
import { TRAINING_EXPORT_LOCK_MS } from "./process-training-export-job.ts";

describe("TRAINING_EXPORT_LOCK_MS", () => {
  it("is 10 minutes", () => {
    expect(TRAINING_EXPORT_LOCK_MS).toBe(600_000);
  });
});
