import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmptyStatePreview } from "./EmptyStatePreview";

describe("EmptyStatePreview", () => {
  it("renders a value-free future structure and optional requirement", () => {
    render(
      <EmptyStatePreview
        content={{
          title: "Your monthly report will appear here",
          message: "No report data is available yet.",
          requirement: "Server-owned coverage requirement.",
          previewTitle: "When ready, your report will include",
          previewItems: ["Training time", "Average sleep"],
          note: "No personal values are estimated.",
        }}
      />,
    );

    expect(screen.getByText("Your monthly report will appear here")).toBeTruthy();
    expect(screen.getByText("No report data is available yet.")).toBeTruthy();
    expect(screen.getByText("Server-owned coverage requirement.")).toBeTruthy();
    expect(screen.getByText("When ready, your report will include")).toBeTruthy();
    expect(screen.getByText("Training time")).toBeTruthy();
    expect(screen.getByText("Average sleep")).toBeTruthy();
    expect(screen.getByText("No personal values are estimated.")).toBeTruthy();
  });
});
