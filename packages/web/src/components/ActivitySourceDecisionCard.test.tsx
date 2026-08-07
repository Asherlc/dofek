/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ActivitySourceDecisionCard } from "./ActivitySourceDecisionCard.tsx";

describe("ActivitySourceDecisionCard", () => {
  it("shows how sources were combined from the server decision", () => {
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

    expect(screen.getByRole("heading", { name: "How sources were combined" })).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("Wahoo")).toBeTruthy();
    expect(
      screen.getByText(
        "Wahoo was selected as the primary record by source priority. Missing details may come from the other matched sources.",
      ),
    ).toBeTruthy();
  });
});
