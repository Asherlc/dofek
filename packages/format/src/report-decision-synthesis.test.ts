import { describe, expect, it } from "vitest";
import {
  keyedDecisionSynthesisItems,
  reportDecisionSynthesisSections,
} from "./report-decision-synthesis.ts";

describe("report decision synthesis formatting", () => {
  it("defines the shared section order and titles", () => {
    expect(reportDecisionSynthesisSections).toEqual([
      { key: "whatChanged", title: "What changed" },
      { key: "likelyAssociations", title: "Likely associations" },
      { key: "whatWorked", title: "What worked" },
      { key: "whatToTryNext", title: "What to try next" },
      { key: "confidenceAndMissingData", title: "Confidence and missing data" },
    ]);
  });

  it("assigns stable occurrence-aware keys to repeated narrative items", () => {
    expect(keyedDecisionSynthesisItems(["Repeated evidence.", "Repeated evidence."])).toEqual([
      { key: '["Repeated evidence.",0]', text: "Repeated evidence." },
      { key: '["Repeated evidence.",1]', text: "Repeated evidence." },
    ]);
  });
});
