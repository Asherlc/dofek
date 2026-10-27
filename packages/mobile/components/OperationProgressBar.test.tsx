import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { OperationProgressBar, OperationProgressBars } from "./OperationProgressBar";

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

  it("does not expose technical operation messages", () => {
    render(<OperationProgressBar message="Failed query: SELECT * FROM users" />);

    expect(screen.getByText("We couldn't complete this request. Please try again.")).toBeTruthy();
    expect(screen.queryByText(/SELECT/)).toBeNull();
  });

  it("renders simultaneous operations as independent progress bars", () => {
    render(
      <OperationProgressBars
        operations={[
          { id: "sync", label: "Provider sync", percentage: 64, message: "Syncing activities" },
          { id: "delete", label: "Provider data deletion", message: "Deleting records" },
        ]}
      />,
    );

    expect(screen.getAllByTestId("operation-progress-bar")).toHaveLength(2);
    expect(screen.getByText("Provider sync")).toBeTruthy();
    expect(screen.getByText("Provider data deletion")).toBeTruthy();
  });
});
