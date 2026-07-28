/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { MethodExplanation } from "./MethodExplanation.tsx";

describe("MethodExplanation", () => {
  it("renders explanation lines in order with the primary source link", () => {
    const { container } = render(
      <MethodExplanation
        className="mt-2"
        lines={["Formula details", "Calendar details", "Interpretation details"]}
        source={{
          title: "Primary source",
          url: "https://example.com/primary-source",
        }}
      />,
    );

    expect([...container.querySelectorAll("p")].map((line) => line.textContent)).toEqual([
      "Formula details",
      "Calendar details",
      "Interpretation details",
    ]);
    expect(container.firstElementChild).toHaveClass("mt-2", "space-y-1", "text-xs", "text-dim");
    expect(screen.getByRole("link", { name: "Primary source" })).toHaveAttribute(
      "href",
      "https://example.com/primary-source",
    );
    expect(screen.getByRole("link", { name: "Primary source" })).toHaveAttribute(
      "target",
      "_blank",
    );
    expect(screen.getByRole("link", { name: "Primary source" })).toHaveAttribute(
      "rel",
      "noreferrer",
    );
  });
});
