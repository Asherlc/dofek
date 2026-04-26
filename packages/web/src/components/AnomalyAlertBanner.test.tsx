/** @vitest-environment jsdom */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { AnomalyRow } from "../../../server/src/routers/anomaly-detection.ts";
import { AnomalyAlertBanner } from "./AnomalyAlertBanner.tsx";

function makeAnomaly(overrides: Partial<AnomalyRow> = {}): AnomalyRow {
  return {
    date: "2026-04-26",
    metric: "Heart Rate Variability",
    value: 26.3,
    baselineMean: 60.2,
    baselineStddev: 10.5,
    zScore: -3.24,
    severity: "alert",
    ...overrides,
  };
}

describe("AnomalyAlertBanner", () => {
  it("uses alert-specific contrast colors instead of inherited theme greens", () => {
    const { container } = render(<AnomalyAlertBanner anomalies={[makeAnomaly()]} />);

    const banner = container.firstElementChild;
    expect(banner?.className).toContain("bg-red-50");
    expect(banner?.className).toContain("border-red-200");
    expect(screen.getByRole("heading", { name: "Health Alert" }).className).toContain(
      "text-red-800",
    );

    const item = screen.getByText(/Heart Rate Variability/).closest("li");
    if (!item) throw new Error("Anomaly row was not rendered");

    expect(item.className).toContain("text-red-950");
    expect(item.className).not.toContain("text-foreground");
    expect(within(item).getByText(/\(baseline:/).className).toContain("text-red-800");
    expect(within(item).getByText(/\(baseline:/).className).not.toContain("text-subtle");
  });

  it("uses warning-specific contrast colors", () => {
    const { container } = render(
      <AnomalyAlertBanner anomalies={[makeAnomaly({ severity: "warning" })]} />,
    );

    const banner = container.firstElementChild;
    expect(banner?.className).toContain("bg-yellow-50");
    expect(banner?.className).toContain("border-yellow-300");
    expect(screen.getByRole("heading", { name: "Health Warning" }).className).toContain(
      "text-yellow-900",
    );
  });

  it("renders nothing while loading or when there are no anomalies", () => {
    const loadingResult = render(<AnomalyAlertBanner anomalies={[makeAnomaly()]} loading={true} />);
    expect(loadingResult.container.innerHTML).toBe("");

    const emptyResult = render(<AnomalyAlertBanner anomalies={[]} />);
    expect(emptyResult.container.innerHTML).toBe("");
  });
});
