import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OperationProgressBar } from "./OperationProgressBar";

describe("OperationProgressBar", () => {
  it("renders determinate progress and its message", () => {
    render(<OperationProgressBar percentage={42} message="Deleting records..." />);

    expect(
      screen.getByTestId("operation-progress-bar").getAttribute("accessibilityValue"),
    ).not.toBeNull();
    expect(screen.getByText("Deleting records...")).toBeTruthy();
  });

  it("renders indeterminate progress without an accessibility value", () => {
    render(<OperationProgressBar message="Waiting for deletion worker..." />);

    expect(
      screen.getByTestId("operation-progress-bar").getAttribute("accessibilityValue"),
    ).toBeNull();
    expect(screen.getByText("Waiting for deletion worker...")).toBeTruthy();
  });
});
