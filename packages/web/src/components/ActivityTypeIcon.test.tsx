/** @vitest-environment jsdom */
import { getActivityIconInfo } from "@dofek/training/activity-icons";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityTypeIcon } from "./ActivityTypeIcon";

afterEach(cleanup);

describe("ActivityTypeIcon", () => {
  it.each([
    ["running", "Running"],
    ["hangboard", "Hangboarding"],
    ["archery", "Archery"],
  ])("renders the canonical %s outline with an accessible label", (activityType, label) => {
    render(<ActivityTypeIcon activityType={activityType} />);
    const icon = screen.getByRole("img", { name: `${label} activity` });
    const glyph = icon.querySelector<HTMLElement>("[data-activity-glyph]");
    expect(glyph?.style.maskImage).toBe(
      `url("data:image/svg+xml,${encodeURIComponent(getActivityIconInfo(activityType).svg)}")`,
    );
    expect(glyph?.style.backgroundColor).toBe("currentcolor");
    expect(glyph?.getAttribute("aria-hidden")).toBe("true");
  });

  it("preserves the card aspect ratio", () => {
    render(<ActivityTypeIcon activityType="indoor_cycling" variant="card" />);
    expect(screen.getByTestId("activity-type-icon").className).toContain("aspect-[16/9]");
  });

  it("keeps compact table sizing and supplied color", () => {
    render(<ActivityTypeIcon activityType="strength_training" variant="compact" color="#abc123" />);
    const icon = screen.getByTestId("activity-type-icon");
    expect(icon.className).toContain("h-12");
    expect(icon.className).toContain("w-16");
    expect(icon.style.color).toBe("rgb(171, 193, 35)");
  });

  it("uses the foreground theme color in the plain variant", () => {
    render(<ActivityTypeIcon activityType="strength_training" variant="plain" />);
    const icon = screen.getByTestId("activity-type-icon");
    expect(icon.className).toContain("h-12");
    expect(icon.className).toContain("w-16");
    expect(icon.className).toContain("text-foreground");
    expect(icon.style.backgroundImage).toBe("");
  });
});
