/** @vitest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MethodExplanation } from "./MethodExplanation.tsx";

describe("MethodExplanation", () => {
  it("keeps technical method details collapsed until requested", () => {
    const { container } = render(
      <MethodExplanation
        className="mt-2"
        technicalName="Polarization Index (Treff three-zone model)"
        lines={["Formula details", "Calendar details", "Interpretation details"]}
        source={{
          title: "Primary source",
          url: "https://example.com/primary-source",
        }}
      />,
    );

    expect(container.querySelector("details")).not.toBeNull();
    expect(screen.getByText("How this is calculated")).toBeInTheDocument();
    expect(screen.getByText("Formula details")).not.toBeVisible();

    fireEvent.click(screen.getByText("How this is calculated"));
    expect(
      screen.getByText("Technical name: Polarization Index (Treff three-zone model)"),
    ).toBeVisible();
    expect(screen.getByText("Formula details")).toBeVisible();
    expect([...container.querySelectorAll("details p")].map((line) => line.textContent)).toEqual([
      "Technical name: Polarization Index (Treff three-zone model)",
      "Formula details",
      "Calendar details",
      "Interpretation details",
    ]);
    expect(screen.getByRole("link", { name: "Primary source" })).toHaveAttribute(
      "href",
      "https://example.com/primary-source",
    );
  });
});
