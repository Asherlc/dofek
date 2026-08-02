/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { InsightEvidenceDetails } from "./InsightEvidenceDetails.tsx";

describe("InsightEvidenceDetails", () => {
  it("renders only present evidence details", () => {
    const { container } = render(
      <InsightEvidenceDetails
        evidence={{
          method: "Server method.",
          limitations: "Server limitations.",
        }}
      />,
    );

    expect(screen.getByText("Server method.")).toBeTruthy();
    expect(screen.getByText("Server limitations.")).toBeTruthy();
    expect(container.querySelectorAll("p")).toHaveLength(2);
  });

  it("renders nothing when no detail fields are present", () => {
    const { container } = render(<InsightEvidenceDetails evidence={{}} />);

    expect(container.firstChild).toBeNull();
  });
});
