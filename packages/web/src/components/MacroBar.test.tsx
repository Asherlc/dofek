// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { MacroBar } from "./MacroBar.tsx";

afterEach(cleanup);

describe("MacroBar", () => {
  it("clamps visual progress without hiding the server-owned percentage", () => {
    const { container } = render(
      <MacroBar label="Protein" grams="135 g" percentage={135} color="blue" />,
    );

    expect(container.querySelector(".bg-blue-500")?.getAttribute("style")).toContain("100%");
    expect(screen.getByText("(135%)")).not.toBeNull();
  });
});
