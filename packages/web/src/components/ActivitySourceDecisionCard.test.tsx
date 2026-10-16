/** @vitest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ActivitySourceDecisionCard } from "./ActivitySourceDecisionCard.tsx";

describe("ActivitySourceDecisionCard", () => {
  it("expands and collapses the server source decision on demand", () => {
    render(
      <ActivitySourceDecisionCard
        decision={{
          sourceCount: 2,
          primarySourceLabel: "Wahoo",
          explanation:
            "Wahoo was selected as the primary record by source priority. Missing details may come from the other matched sources.",
        }}
      />,
    );

    const toggle = screen.getByRole("button", { name: "How sources were combined" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("Wahoo")).not.toBeVisible();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("Wahoo")).toBeVisible();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("Wahoo")).not.toBeVisible();
  });
});
