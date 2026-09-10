/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ActivityPerceivedExertion } from "./ActivityPerceivedExertion.tsx";

describe("ActivityPerceivedExertion", () => {
  it("displays stored session perceived exertion", () => {
    render(<ActivityPerceivedExertion value={7} />);

    expect(screen.getByText("Session effort")).toBeTruthy();
    expect(screen.getByText("7")).toBeTruthy();
  });

  it("does not render when session effort was not recorded", () => {
    render(<ActivityPerceivedExertion value={null} />);

    expect(screen.queryByText("Session effort")).toBeNull();
  });
});
