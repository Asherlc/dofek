import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityTypeIcon } from "./ActivityTypeIcon";

afterEach(cleanup);

describe("ActivityTypeIcon", () => {
  it("renders a hangboard illustration instead of the generic activity emoji", () => {
    const { container } = render(<ActivityTypeIcon activityType="hangboard" />);
    expect(container.querySelector("SvgXml")?.getAttribute("xml")).toContain("<svg");
    expect(container.textContent).not.toContain("⚡");
    expect(container.firstElementChild?.getAttribute("aria-label")).toBe("Hangboarding activity");
  });

  it("keeps the existing emoji for other activity types", () => {
    const { container } = render(<ActivityTypeIcon activityType="running" />);
    expect(container.querySelector("SvgXml")).toBeNull();
    expect(container.textContent).toContain("🏃");
  });
});
