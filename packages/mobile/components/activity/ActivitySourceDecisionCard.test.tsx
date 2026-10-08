import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ActivitySourceDecisionCard } from "./ActivitySourceDecisionCard";

describe("ActivitySourceDecisionCard", () => {
  it("expands and collapses the server source decision on demand", () => {
    render(
      <ActivitySourceDecisionCard
        decision={{ sourceCount: 2, primarySourceLabel: "Wahoo", explanation: "Source priority." }}
      />,
    );

    const toggle = screen.getByRole("button", { name: "How sources were combined" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Wahoo")).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("Wahoo")).toBeTruthy();
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Wahoo")).toBeNull();
  });
});
