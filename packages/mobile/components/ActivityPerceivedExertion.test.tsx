/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ActivityPerceivedExertion } from "./ActivityPerceivedExertion";

describe("ActivityPerceivedExertion", () => {
  it("displays session effort on the 0–10 scale", () => {
    render(<ActivityPerceivedExertion value={7} />);

    expect(screen.getByText("Session effort")).toBeTruthy();
    expect(screen.getByText("7/10")).toBeTruthy();
  });

  it("does not render when session effort was not recorded", () => {
    render(<ActivityPerceivedExertion value={null} />);

    expect(screen.queryByText("Session effort")).toBeNull();
  });
});
