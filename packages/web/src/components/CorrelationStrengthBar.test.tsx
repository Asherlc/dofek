/** @vitest-environment jsdom */

import { chartColors } from "@dofek/scoring/colors";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CorrelationStrengthBar } from "./CorrelationStrengthBar.tsx";

afterEach(cleanup);

function cssRgb(hex: string): string {
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  return `rgb(${red}, ${green}, ${blue})`;
}

describe("CorrelationStrengthBar", () => {
  it("uses one neutral relationship color regardless of direction", () => {
    const { rerender } = render(<CorrelationStrengthBar rho={0.75} />);

    expect(screen.getByTestId("correlation-fill").style.backgroundColor).toBe(
      cssRgb(chartColors.blue),
    );
    expect(screen.getByText("+0.75")).toBeTruthy();

    rerender(<CorrelationStrengthBar rho={-0.75} />);

    expect(screen.getByTestId("correlation-fill").style.backgroundColor).toBe(
      cssRgb(chartColors.blue),
    );
    expect(screen.getByText("-0.75")).toBeTruthy();
  });
});
