import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { CyclingThresholdEvidence } from "../../server/src/contracts/cycling-threshold.ts";
import { CyclingThresholdDetails } from "./CyclingThresholdDetails";

const evidence: CyclingThresholdEvidence = {
  value: 250,
  unit: "watt",
  method: "computed_eftp",
  event_at: "2026-06-01T00:00:00Z",
  evidence_activity_id: null,
  evidence_at: "2026-05-31T12:00:00Z",
  evidence_duration_seconds: 1200,
  evidence_power: 265,
  model_version: "v1",
  unavailable_reason: null,
  uncertainty: {
    kind: "not_quantifiable",
    watts: null,
    reason: "Individual uncertainty is not quantified.",
  },
};
afterEach(cleanup);
describe("CyclingThresholdDetails", () => {
  it("shows unavailable evidence with the server's reason", () => {
    render(
      <CyclingThresholdDetails
        evidence={{ ...evidence, value: null, unavailable_reason: "No qualifying effort" }}
      />,
    );
    expect(screen.getByText("No qualifying effort")).toBeTruthy();
  });
  it.each(["evidence_at", "evidence_duration_seconds", "evidence_power"] as const)(
    "withholds the evidence line when %s is missing",
    (field) => {
      render(<CyclingThresholdDetails evidence={{ ...evidence, [field]: null }} />);
      expect(screen.getByText("Computed eFTP: 250 W")).toBeTruthy();
      expect(screen.queryByText(/Evidence:/)).toBeNull();
    },
  );
  it("retains measured zero effort power and explains eFTP in the disclosure", () => {
    render(<CyclingThresholdDetails evidence={{ ...evidence, evidence_power: 0 }} />);
    expect(screen.getByText(/Evidence:.*0 W/)).toBeTruthy();
    expect(screen.queryByText(evidence.uncertainty.reason)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Estimate uncertainty" }));
    expect(screen.getByText("eFTP means estimated functional threshold power.")).toBeTruthy();
    expect(screen.getByText(evidence.uncertainty.reason)).toBeTruthy();
  });
});
