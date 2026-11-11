import { getActivityIconInfo } from "@dofek/training/activity-icons";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { colors } from "../theme";
import { ActivityTypeIcon } from "./ActivityTypeIcon";

afterEach(cleanup);

describe("ActivityTypeIcon", () => {
  it.each([
    ["running", "Running"],
    ["hangboard", "Hangboarding"],
    ["archery", "Archery"],
  ])("renders the shared %s geometry with a theme color", (activityType, label) => {
    const { container } = render(<ActivityTypeIcon activityType={activityType} />);
    const svg = container.querySelector("SvgXml");
    expect(svg?.getAttribute("xml")).toBe(getActivityIconInfo(activityType).svg);
    expect(svg?.getAttribute("color")).toBe(colors.text);
    expect(container.firstElementChild?.getAttribute("aria-label")).toBe(`${label} activity`);
  });

  it("preserves compact sizing and accepts a supplied theme color", () => {
    const { container } = render(
      <ActivityTypeIcon activityType="hangboard" size={32} color="#f1f7f2" />,
    );
    const icon = container.querySelector<HTMLElement>('[aria-label="Hangboarding activity"]');
    expect(icon?.style.width).toBe("32px");
    expect(icon?.style.height).toBe("32px");
    const svg = container.querySelector("SvgXml");
    expect(svg?.getAttribute("width")).toBe("24");
    expect(svg?.getAttribute("height")).toBe("24");
    expect(svg?.getAttribute("color")).toBe("#f1f7f2");
  });
});
