/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EvidenceDetails } from "./EvidenceDetails.tsx";

describe("EvidenceDetails", () => {
  it("renders labeled and unlabeled server details while skipping blank values", () => {
    const { container } = render(
      <EvidenceDetails
        details={[
          { key: "method", label: "Method", value: "Server method." },
          { key: "interpretation", label: "Interpretation", value: "  " },
          { key: "note", value: "Server note." },
          { key: "missing", label: "Missing", value: undefined },
        ]}
      />,
    );

    expect(container.querySelector("p")?.textContent).toBe("Method: Server method.");
    expect(screen.getByText("Server method.")).toBeTruthy();
    expect(screen.getByText("Server note.")).toBeTruthy();
    expect(container.querySelectorAll("p")).toHaveLength(2);
  });

  it("renders nothing when all details are absent", () => {
    const { container } = render(
      <EvidenceDetails
        details={[
          { key: "method", label: "Method", value: null },
          { key: "note", value: "" },
        ]}
      />,
    );

    expect(container.firstChild).toBeNull();
  });
});
