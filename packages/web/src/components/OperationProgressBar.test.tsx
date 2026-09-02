// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { OperationProgressBar, OperationProgressBars } from "./OperationProgressBar.tsx";

afterEach(cleanup);

describe("OperationProgressBar", () => {
  it("renders determinate progress with an accessible value", () => {
    render(<OperationProgressBar percentage={42} message="Deleting records..." />);

    const progressBar = screen.getByRole("progressbar");
    expect(progressBar.getAttribute("aria-valuenow")).toBe("42");
    expect(screen.getByText("Deleting records...")).not.toBeNull();
  });

  it("renders indeterminate progress without inventing a percentage", () => {
    render(<OperationProgressBar message="Waiting for deletion worker..." />);

    const progressBar = screen.getByRole("progressbar");
    expect(progressBar.hasAttribute("aria-valuenow")).toBe(false);
    expect(screen.getByText("Waiting for deletion worker...")).not.toBeNull();
  });

  it("clamps visual progress to the supported range", () => {
    const { rerender } = render(<OperationProgressBar percentage={-5} />);
    expect(screen.getByTestId("operation-progress-fill").getAttribute("style")).toContain("0%");

    rerender(<OperationProgressBar percentage={150} />);
    expect(screen.getByTestId("operation-progress-fill").getAttribute("style")).toContain("100%");
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

    expect(screen.getAllByRole("progressbar")).toHaveLength(2);
    expect(screen.getByText("Provider sync")).not.toBeNull();
    expect(screen.getByText("Provider data deletion")).not.toBeNull();
  });
});
