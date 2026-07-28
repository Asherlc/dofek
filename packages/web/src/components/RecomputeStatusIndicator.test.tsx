/** @vitest-environment jsdom */
import { operationalStatusColors } from "@dofek/scoring/colors";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RecomputeStatusIndicator } from "./RecomputeStatusIndicator.tsx";

describe("RecomputeStatusIndicator", () => {
  it("shows a compact named progress indicator", () => {
    render(<RecomputeStatusIndicator label="Recomputing sleep" progress={60} status="active" />);

    const progress = screen.getByRole("progressbar", { name: "Recomputing sleep" });
    expect(progress.getAttribute("aria-valuenow")).toBe("60");
    expect(screen.getByText("Recomputing sleep", { selector: "span" })).toBeTruthy();
    expect(screen.queryByRole("heading")).toBeNull();
    expect(progress).toHaveStyle({ color: operationalStatusColors.info.indicator });
  });

  it("keeps an indeterminate off-the-shelf spinner beside its wrapping label", () => {
    render(
      <RecomputeStatusIndicator
        label="Recomputing activities, sleep, recovery, training, and body"
        progress={null}
        status="delayed"
      />,
    );

    const progress = screen.getByRole("progressbar", {
      name: "Recomputing activities, sleep, recovery, training, and body",
    });
    expect(progress.getAttribute("data-testid")).toBe("recompute-spinner");
    expect(progress.parentElement?.className).toContain("w-full");
    expect(progress.nextElementSibling?.textContent).toBe(
      "Recomputing activities, sleep, recovery, training, and body",
    );
    expect(progress).toHaveStyle({ color: operationalStatusColors.warning.indicator });
  });
});
