/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ActivityPerceivedExertion } from "./ActivityPerceivedExertion";

describe("ActivityPerceivedExertion", () => {
  it("displays stored session perceived exertion", () => {
    render(<ActivityPerceivedExertion value={7} />);

    expect(screen.getByText("Session effort")).toBeTruthy();
    expect(screen.getByText("7")).toBeTruthy();
  });
});
