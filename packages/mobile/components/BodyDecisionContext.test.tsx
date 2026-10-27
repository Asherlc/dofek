import { BODY_TREND_WEIGHT_DECISION_COPY } from "@dofek/format/body-decision-context";
import { fireEvent, render, screen } from "@testing-library/react";
import { Alert } from "react-native";
import { describe, expect, it, vi } from "vitest";
import { BodyDecisionContext } from "./BodyDecisionContext";

vi.mock("../lib/trpc", () => ({
  trpc: { settings: { get: { useQuery: () => ({ data: { value: "metric" } }) } } },
}));

const context = {
  latestMeasurement: {
    date: "2026-07-25",
    recordedAt: "2026-07-25T15:00:00.000Z",
    recordedAtLocal: "2026-07-25 08:00:00",
    weightKg: 80,
    providerId: "withings",
    sourceName: "Body+",
  },
  trendWeight: {
    smoothing: "ewma" as const,
    alpha: 0.1,
    gapHandling: "linear_interpolation" as const,
    invalidWeightHandling: "exclude_non_positive" as const,
    outlierHandling: "retain" as const,
  },
  variation: {
    status: "available" as const,
    observations: 12,
    minimumObservations: 8,
    maximumObservations: 30,
    method: "tukey_inner_fence" as const,
    lowerResidualKg: -0.4,
    upperResidualKg: 0.6,
    outliersIncluded: true as const,
  },
};

describe("BodyDecisionContext", () => {
  it("renders scale-reading provenance and personal variation", () => {
    render(<BodyDecisionContext context={context} />);

    expect(screen.getByText(/Latest scale reading: 80\.0 kg/)).toBeTruthy();
    expect(screen.getByText(/-0\.4 kg to \+0\.6 kg/)).toBeTruthy();
  });

  it("opens the Trend Weight method from About", () => {
    const alertSpy = vi.spyOn(Alert, "alert").mockImplementation(() => {});
    render(<BodyDecisionContext context={context} />);

    fireEvent.click(screen.getByRole("button", { name: "About Trend Weight" }));
    expect(alertSpy).toHaveBeenCalledWith("Trend Weight", BODY_TREND_WEIGHT_DECISION_COPY, [
      { text: "Close" },
    ]);
    alertSpy.mockRestore();
  });

  it("explains when decision context is unavailable", () => {
    render(<BodyDecisionContext context={null} />);

    expect(
      screen.getByText(
        "Measurement decision context is temporarily unavailable. Refresh to try again.",
      ),
    ).toBeTruthy();
  });
});
