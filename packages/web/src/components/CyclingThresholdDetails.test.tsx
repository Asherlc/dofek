/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { CyclingThresholdEvidence } from "../../../server/src/contracts/cycling-threshold.ts";
import { CyclingThresholdDetails } from "./CyclingThresholdDetails";

const baseEvidence: CyclingThresholdEvidence = {
  value: 250,
  unit: "watt",
  method: "configured",
  effective_from: "2026-06-01",
  source_record_id: "00000000-0000-4000-8000-000000000101",
  unavailable_reason: null,
};

afterEach(cleanup);
describe("CyclingThresholdDetails", () => {
  it("shows applied FTP when value is set", () => {
    const evidence = { ...baseEvidence };
    render(<CyclingThresholdDetails evidence={evidence} />);
    expect(screen.getByText(/Applied FTP: 250 W/)).toBeVisible();
  });

  it("shows effective from date when provided", () => {
    const evidence = { ...baseEvidence, value: 250, effective_from: "2026-06-01" };
    render(<CyclingThresholdDetails evidence={evidence} />);
    expect(screen.getByText(/Effective from/)).toBeVisible();
    expect(screen.getByText(/Jun 1, 2026/)).toBeVisible();
  });

  it.each(["effective_from"] as const)(
    "withholds the Effective from line when %s is missing",
    (field) => {
      const evidence = { ...baseEvidence, [field]: null };
      render(<CyclingThresholdDetails evidence={evidence} />);
      expect(screen.queryByText(/Applied FTP: 250 W/)).toBeVisible();
      expect(screen.queryByText(/Effective from/)).toBeNull();
    },
  );

  it("shows applied FTP for a valid user-entered value", () => {
    const evidence = { ...baseEvidence, value: 100 };
    render(<CyclingThresholdDetails evidence={evidence} />);
    expect(screen.getByText(/Applied FTP: 100 W/)).toBeVisible();
  });
});
