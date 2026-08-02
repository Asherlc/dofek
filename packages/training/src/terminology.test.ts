import { describe, expect, it } from "vitest";
import { TRAINING_TERMINOLOGY } from "./terminology.ts";

describe("TRAINING_TERMINOLOGY", () => {
  it("keeps the plain-language label separate from technical details", () => {
    for (const entry of Object.values(TRAINING_TERMINOLOGY)) {
      expect(entry.plainLabel).toBeTruthy();
      expect(entry.plainDescription).toBeTruthy();
      expect(entry.technicalName).toBeTruthy();
      expect(entry.details).toBeTruthy();
      expect(entry.plainLabel).not.toContain(entry.technicalName);
      expect(entry.plainDescription).not.toContain(entry.technicalName);
    }
  });
});
