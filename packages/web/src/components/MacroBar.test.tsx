// @vitest-environment jsdom

import { chartColors } from "@dofek/scoring/colors";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MacroBar } from "./MacroBar.tsx";

afterEach(cleanup);

function cssRgb(hex: string): string {
  const red = Number.parseInt(hex.slice(1, 3), 16);
  const green = Number.parseInt(hex.slice(3, 5), 16);
  const blue = Number.parseInt(hex.slice(5, 7), 16);
  return `rgb(${red}, ${green}, ${blue})`;
}

describe("MacroBar", () => {
  it("labels the server-owned energy share separately from logged grams", () => {
    const { container } = render(
      <MacroBar label="Protein" grams={65} energySharePercentage={25} color="blue" />,
    );

    expect(
      container.querySelector('[data-testid="macro-bar-fill"]')?.getAttribute("style"),
    ).toContain("25%");
    expect(screen.getByText("25% of energy")).not.toBeNull();
    expect(screen.getByText("65 g logged")).not.toBeNull();
    expect(
      screen.getByRole("meter", {
        name: "Protein: 25% share of energy; 65 grams logged",
      }),
    ).not.toBeNull();
  });

  it("uses neutral categorical colors instead of status colors", () => {
    const { rerender } = render(
      <MacroBar label="Protein" grams={30} energySharePercentage={30} color="blue" />,
    );

    expect(screen.getByTestId("macro-bar-fill").style.backgroundColor).toBe(
      cssRgb(chartColors.blue),
    );

    rerender(<MacroBar label="Carbs" grams={50} energySharePercentage={50} color="purple" />);
    expect(screen.getByTestId("macro-bar-fill").style.backgroundColor).toBe(
      cssRgb(chartColors.purple),
    );

    rerender(<MacroBar label="Fat" grams={20} energySharePercentage={20} color="teal" />);
    expect(screen.getByTestId("macro-bar-fill").style.backgroundColor).toBe(
      cssRgb(chartColors.teal),
    );
  });
});
