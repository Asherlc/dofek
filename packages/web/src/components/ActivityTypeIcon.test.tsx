/** @vitest-environment jsdom */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityTypeIcon } from "./ActivityTypeIcon";

afterEach(cleanup);

describe("ActivityTypeIcon", () => {
  it("renders a card-sized placeholder with an activity icon", () => {
    render(<ActivityTypeIcon activityType="indoor_cycling" variant="card" />);

    const icon = screen.getByTestId("activity-type-icon");
    expect(icon.className).toContain("aspect-[16/9]");
    expect(icon.getAttribute("aria-label")).toBe("Indoor Cycling activity");
    expect(icon.textContent?.length).toBeGreaterThan(0);
  });

  it("renders a compact placeholder for table rows", () => {
    render(<ActivityTypeIcon activityType="strength_training" variant="compact" />);

    const icon = screen.getByTestId("activity-type-icon");
    expect(icon.className).toContain("h-12");
    expect(icon.className).toContain("w-16");
    expect(icon.getAttribute("aria-label")).toBe("Strength Training activity");
  });

  it("renders a plain aligned icon without a colored background", () => {
    render(<ActivityTypeIcon activityType="strength_training" variant="plain" />);

    const icon = screen.getByTestId("activity-type-icon");
    expect(icon.className).toContain("h-12");
    expect(icon.className).toContain("w-16");
    expect(icon.getAttribute("style")).toBeNull();
  });
});
