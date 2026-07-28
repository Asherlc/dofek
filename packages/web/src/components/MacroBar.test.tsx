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
  it("clamps visual progress without hiding the server-owned percentage", () => {
    const { container } = render(
      <MacroBar label="Protein" grams="135 g" percentage={135} color="blue" />,
    );

    expect(
      container.querySelector('[data-testid="macro-bar-fill"]')?.getAttribute("style"),
    ).toContain("100%");
    expect(screen.getByText("(135%)")).not.toBeNull();
  });

  it("uses neutral categorical colors instead of status colors", () => {
    const { rerender } = render(
      <MacroBar label="Protein" grams="30 g" percentage={30} color="blue" />,
    );

    expect(screen.getByTestId("macro-bar-fill").style.backgroundColor).toBe(
      cssRgb(chartColors.blue),
    );

    rerender(<MacroBar label="Carbs" grams="50 g" percentage={50} color="purple" />);
    expect(screen.getByTestId("macro-bar-fill").style.backgroundColor).toBe(
      cssRgb(chartColors.purple),
    );

    rerender(<MacroBar label="Fat" grams="20 g" percentage={20} color="teal" />);
    expect(screen.getByTestId("macro-bar-fill").style.backgroundColor).toBe(
      cssRgb(chartColors.teal),
    );
  });
});
