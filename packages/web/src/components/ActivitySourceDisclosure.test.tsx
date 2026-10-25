/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { branchingSourceTree } from "./ActivitySourceDisclosure.fixtures.ts";
import { ActivitySourceDisclosure } from "./ActivitySourceDisclosure.tsx";

afterEach(cleanup);

describe("ActivitySourceDisclosure", () => {
  it("shows the Garmin model thumbnail in the inline control", () => {
    render(
      <ActivitySourceDisclosure
        tree={{
          primary: {
            id: "garmin-record",
            providerId: "garmin",
            sourceName: "Forerunner 965",
            label: "Forerunner 965",
            description: "Closest available recording",
            url: null,
            children: [],
          },
          otherSources: [],
        }}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Forerunner 965 Sources" });
    expect(trigger.querySelector("img")).toHaveAttribute(
      "src",
      expect.stringContaining("010-02809-00"),
    );
    expect(trigger.querySelector("img")).toHaveAttribute("width", "18");
    fireEvent.click(trigger);
    expect(screen.getAllByText("Forerunner 965")).toHaveLength(1);
    expect(screen.getByText("Closest available recording")).toBeVisible();
  });

  it("expands inline with one primary root and distinct transfer branches", () => {
    render(<ActivitySourceDisclosure tree={branchingSourceTree} />);
    const trigger = screen.getByRole("button", { name: "Garmin Connect Sources" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger.querySelectorAll("img")).toHaveLength(1);
    expect(screen.queryByText("Strava")).toBeNull();
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const content = document.getElementById(trigger.getAttribute("aria-controls") ?? "");
    expect(content).toBeVisible();
    expect(screen.getAllByText("Garmin Connect")).toHaveLength(1);
    expect(screen.getByText("Closest available recording")).toBeVisible();
    const strava = screen.getByRole("link", { name: "Strava" }).closest("li");
    expect(strava).not.toBeNull();
    if (!strava) throw new Error("Missing Strava tree node");
    expect(within(strava).getByText("Imported from Strava")).toBeVisible();
    expect(screen.getAllByText("Apple Health")).toHaveLength(2);
    expect(screen.getAllByText("Imported from Garmin Connect")).toHaveLength(2);
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Strava")).toBeNull();
  });

  it("retains disconnected components outside the primary tree", () => {
    render(<ActivitySourceDisclosure tree={branchingSourceTree} />);
    fireEvent.click(screen.getByRole("button", { name: "Garmin Connect Sources" }));
    const others = screen.getByRole("region", { name: "Other matching sources" });
    expect(within(others).getByText("WHOOP")).toBeVisible();
    expect(within(others).getByText("Transfer history unavailable")).toBeVisible();
    expect(within(others).queryByText("Strava")).toBeNull();
  });

  it("shows a generic disclosure for unresolved sources", () => {
    render(
      <ActivitySourceDisclosure
        tree={{ primary: null, otherSources: branchingSourceTree.otherSources }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    expect(screen.getByText("WHOOP")).toBeVisible();
  });

  it("keeps focus on the native disclosure button and gives each region a unique id", () => {
    render(
      <>
        <ActivitySourceDisclosure tree={branchingSourceTree} />
        <ActivitySourceDisclosure tree={branchingSourceTree} />
      </>,
    );
    const triggers = screen.getAllByRole("button", { name: "Garmin Connect Sources" });
    expect(triggers[0]?.tagName).toBe("BUTTON");
    expect(triggers[0]?.getAttribute("aria-controls")).not.toBe(
      triggers[1]?.getAttribute("aria-controls"),
    );
    const trigger = triggers[0];
    if (!trigger) throw new Error("Missing disclosure");
    trigger.focus();
    fireEvent.click(trigger);
    expect(trigger).toHaveFocus();
  });

  it("renders server labels and URLs without adding Apple Health logo badges", () => {
    render(<ActivitySourceDisclosure tree={branchingSourceTree} />);
    fireEvent.click(screen.getByRole("button", { name: "Garmin Connect Sources" }));
    expect(screen.getByRole("link", { name: "Strava" })).toHaveAttribute(
      "href",
      "https://www.strava.com/activities/123",
    );
    for (const label of screen.getAllByText("Apple Health")) {
      expect(label.parentElement?.querySelectorAll("img")).toHaveLength(1);
    }
    expect(screen.getByRole("link", { name: "View Garmin Connect activity" })).toHaveAttribute(
      "href",
      "https://connect.garmin.com/modern/activity/123",
    );
  });
});
