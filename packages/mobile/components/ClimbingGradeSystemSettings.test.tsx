// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ClimbingGradeSystemSettings } from "./ClimbingGradeSystemSettings";

describe("ClimbingGradeSystemSettings", () => {
  it("keeps the read error visible alongside available grade choices", () => {
    render(
      <ClimbingGradeSystemSettings
        errorMessage="Your session expired. Sign in again to refresh your settings."
        onChange={vi.fn()}
        preference={{ boulder: "v_scale", route: "yds" }}
        saving={false}
      />,
    );

    expect(
      screen.getByText("Your session expired. Sign in again to refresh your settings."),
    ).toBeTruthy();
    expect(screen.getByLabelText("V Scale").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByLabelText("Yosemite Decimal System").getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("updates the selected route grading system", () => {
    const onChange = vi.fn();

    render(
      <ClimbingGradeSystemSettings
        errorMessage={null}
        onChange={onChange}
        preference={{ boulder: "font", route: "yds" }}
        saving={false}
      />,
    );

    fireEvent.click(screen.getByLabelText("French"));

    expect(onChange).toHaveBeenCalledWith({ boulder: "font", route: "french" });
  });

  it("disables every system choice while saving", () => {
    render(
      <ClimbingGradeSystemSettings
        errorMessage={null}
        onChange={vi.fn()}
        preference={{ boulder: "v_scale", route: "yds" }}
        saving
      />,
    );

    expect(screen.getByLabelText("Fontainebleau").getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByLabelText("French").getAttribute("aria-disabled")).toBe("true");
  });
});
