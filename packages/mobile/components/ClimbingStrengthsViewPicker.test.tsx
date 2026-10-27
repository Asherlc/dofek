import type { ClimbingStrengthsView } from "@dofek/training/climbing-strengths-views";
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { expect, it } from "vitest";
import { ClimbingStrengthsViewPicker } from "./ClimbingStrengthsViewPicker";

function Harness() {
  const [value, onChange] = useState<ClimbingStrengthsView>("gaps");
  return <ClimbingStrengthsViewPicker {...{ value, onChange }} />;
}

it("keeps chart format choices behind a disclosure and updates the selected purpose", () => {
  render(<Harness />);
  expect(screen.getByRole("button", { name: "Styles" }).getAttribute("aria-selected")).toBe("true");
  fireEvent.click(screen.getByRole("button", { name: "Chart options" }));
  fireEvent.click(screen.getByRole("button", { name: "View: Style gaps" }));
  fireEvent.click(screen.getByRole("radio", { name: "Success curves" }));
  expect(screen.getByRole("button", { name: "Grades" }).getAttribute("aria-selected")).toBe("true");
  expect(screen.getByRole("button", { name: "View: Success curves" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Grades" }));
  expect(screen.getByRole("button", { name: "View: Success curves" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Progress" }));
  expect(screen.getByRole("button", { name: "View: Progress" })).toBeTruthy();
});
