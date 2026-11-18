import { render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { ActivityExportMenu } from "./ActivityExportMenu";
import meta, { Exporting } from "./ActivityExportMenu.stories";

it("announces the busy format and guards duplicate exports while leaving Cancel available", () => {
  render(<ActivityExportMenu {...meta.args} {...Exporting.args} />);

  for (const format of screen.getAllByRole("button", { name: /^Export as/ })) {
    expect(format.hasAttribute("disabled")).toBe(true);
  }
  expect(screen.getByRole("button", { name: /CSV/ }).getAttribute("aria-busy")).toBe("true");
  expect(screen.getByRole("button", { name: "Cancel export" }).hasAttribute("disabled")).toBe(
    false,
  );
});
