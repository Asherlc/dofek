/** @vitest-environment jsdom */
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
  });
});
