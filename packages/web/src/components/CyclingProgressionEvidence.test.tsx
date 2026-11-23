/** @vitest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { cyclingProgressionFixture } from "./CyclingProgressionEvidence.stories.tsx";
import { CyclingProgressionEvidence } from "./CyclingProgressionEvidence.tsx";

describe("CyclingProgressionEvidence", () => {
  it("shows both dated rides, measured interval power, and whole-ride effort separately", () => {
    render(<CyclingProgressionEvidence result={cyclingProgressionFixture} />);

    const summary = screen.getByText("See interval evidence");
    const details = summary.closest("details");
    expect(details?.open).toBe(false);

    fireEvent.click(summary);

    expect(details?.open).toBe(true);
    expect(screen.getByText(/Selected ride/)).toBeDefined();
    expect(screen.getByText(/Comparison ride/)).toBeDefined();
    expect(screen.getAllByText(/Session effort: 4\/10/)).toHaveLength(2);
    expect(screen.getAllByText(/220 W/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/218 W/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Measured power:/).length).toBeGreaterThan(0);
  });
});
