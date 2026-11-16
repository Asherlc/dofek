import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { CyclingThresholdEvidence } from "../../server/src/contracts/cycling-threshold.ts";
import { CyclingThresholdDetails } from "./CyclingThresholdDetails";

const evidence: CyclingThresholdEvidence = {
  value: 250,
  unit: "watt",
  method: "configured",
  effective_from: "2026-05-31",
  source_record_id: "00000000-0000-4000-8000-000000000101",
  unavailable_reason: null,
};

afterEach(cleanup);
describe("CyclingThresholdDetails", () => {
  it("shows configured FTP and its effective date without exposing record identity", () => {
    render(<CyclingThresholdDetails evidence={evidence} />);
    expect(screen.getByText(/FTP: 250 W/).textContent).toContain("effective Sun, May 31, 2026");
    expect(screen.queryByText(evidence.source_record_id)).toBeNull();
  });

  it("does not show a configured value when the server marks FTP unavailable", () => {
    const unavailable = { ...evidence, value: null, unavailable_reason: "No FTP for this date" };
    render(<CyclingThresholdDetails evidence={unavailable} />);
    expect(screen.queryByText(/FTP:/)).toBeNull();
  });
});
