import { operationalStatusColors } from "@dofek/scoring/colors";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RecomputeStatusIndicator } from "./RecomputeStatusIndicator";

describe("RecomputeStatusIndicator", () => {
  it("shows a compact named progress indicator", () => {
    render(<RecomputeStatusIndicator label="Recomputing sleep" progress={60} status="active" />);

    const progress = screen.getByRole("progressbar", { name: "Recomputing sleep" });
    expect(progress.getAttribute("accessibilityValue")).not.toBeNull();
    expect(screen.getByText("Recomputing sleep")).toBeTruthy();
    expect(progress.querySelector("circle")?.getAttribute("stroke")).toBe(
      operationalStatusColors.info.indicator,
    );
  });
});
