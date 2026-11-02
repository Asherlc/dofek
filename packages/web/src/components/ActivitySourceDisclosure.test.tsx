/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  branchingSourceTree,
  recognizedWatchHardware,
  recognizedWatchSourceTree,
  sourceHardware,
} from "./ActivitySourceDisclosure.fixtures.ts";
import { ActivitySourceDisclosure } from "./ActivitySourceDisclosure.tsx";

afterEach(cleanup);

describe("ActivitySourceDisclosure", () => {
  it("labels the original, sharing direction, and all other branches explicitly", () => {
    render(
      <ActivitySourceDisclosure
        tree={{
          ...branchingSourceTree,
          otherSources: [
            branchingSourceTree.otherSources,
            branchingSourceTree.otherSources.map((node) => ({ ...node, id: `another-${node.id}` })),
          ].flat(),
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Garmin Connect Lineage" }));
    expect(screen.getByText("Original")).toBeVisible();
    expect(screen.getAllByText("Other")).toHaveLength(1);
    expect(screen.getAllByText("Shared to")).toHaveLength(3);
    expect(screen.getAllByText("WHOOP")).toHaveLength(2);
  });
  it("labels unknown origins without assigning a winner", () => {
    render(
      <ActivitySourceDisclosure
        tree={{ primary: null, otherSources: branchingSourceTree.otherSources }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Lineage" }));
    expect(screen.getByText("Original unknown")).toBeVisible();
    expect(screen.getByText("WHOOP")).toBeDefined();
  });

  it("returns keyboard focus to the inline trigger when closing lineage", () => {
    render(<ActivitySourceDisclosure tree={branchingSourceTree} />);
    const trigger = screen.getByRole("button", { name: "Garmin Connect Lineage" });
    fireEvent.click(trigger);
    const close = screen.getByRole("button", { name: "Close lineage" });
    close.focus();
    fireEvent.click(close);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger).toHaveFocus();
  });

  it("opens header sources in a flyout and returns focus after Escape", async () => {
    const { container } = render(
      <ActivitySourceDisclosure tree={branchingSourceTree} heading={<h1>Morning Ride</h1>} />,
    );
    const trigger = screen.getByRole("button", { name: "Garmin Connect Lineage" });
    trigger.focus();
    fireEvent.click(trigger);
    const flyout = screen.getByRole("dialog", { name: "Lineage" });
    expect(within(flyout).getByRole("link", { name: "Strava" })).toBeVisible();
    expect(container.contains(flyout)).toBe(false);
    fireEvent.keyDown(flyout, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    expect(screen.getByRole("heading", { name: "Morning Ride" })).toBeVisible();
  });

  it.each([
    ["whoop", "WHOOP (Cloud)"],
    ["whoop_ble", "WHOOP (Bluetooth)"],
  ])("retains accessible names for nested and additional %s sources", (providerId, label) => {
    const source = {
      id: "child",
      providerId,
      label,
      sourceName: null,
      description: null,
      url: "https://example.com/source",
      children: [],
    };
    render(
      <ActivitySourceDisclosure
        tree={{
          primary: {
            id: "root",
            providerId: "strava",
            label: "Strava",
            sourceName: null,
            description: null,
            url: null,
            children: [source],
          },
          otherSources: [{ ...source, id: "additional" }],
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Strava Lineage" }));
    expect(screen.getAllByRole("link", { name: label })).toHaveLength(2);
  });

  it("shows cloud attribution as an icon while keeping the full accessible source name", () => {
    render(
      <ActivitySourceDisclosure
        tree={{
          primary: {
            id: "whoop",
            providerId: "whoop",
            sourceName: null,
            label: "WHOOP (Cloud)",
            description: null,
            url: null,
            children: [],
          },
          otherSources: [],
        }}
      />,
    );
    const trigger = screen.getByRole("button", { name: "WHOOP (Cloud) Lineage" });
    expect(within(trigger).getByText("WHOOP")).toBeDefined();
    expect(within(trigger).getByTitle("Cloud").querySelector("svg")).toBeTruthy();
  });

  it("discloses recognized watch models once in their provenance branches", () => {
    render(
      <ActivitySourceDisclosure
        tree={recognizedWatchSourceTree}
        hardware={recognizedWatchHardware}
      />,
    );
    const trigger = screen.getByRole("button", {
      name: "Apple Watch Series 7 (GPS + Cellular, 45mm) Lineage",
    });
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByText("Apple Watch Series 7 (GPS + Cellular, 45mm)")).toHaveLength(2);
    expect(screen.getAllByText("Garmin Forerunner 955")).toHaveLength(1);
    expect(screen.getByText("Apple Health")).toBeVisible();
    const garmin = screen.getByRole("link", { name: "Garmin Forerunner 955" }).closest("li");
    if (!garmin) throw new Error("Missing Garmin source branch");
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("Apple Watch Series 7 (GPS + Cellular, 45mm)")).toBeVisible();
  });

  it("offers reported devices when no source tree is available", () => {
    render(
      <ActivitySourceDisclosure
        tree={{ primary: null, otherSources: [] }}
        hardware={sourceHardware}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Lineage" }));
    expect(screen.getByText("Edge 530")).toBeVisible();
  });

  it("keeps a hardware refresh error actionable while Sources is collapsed", () => {
    const retry = vi.fn();
    render(
      <ActivitySourceDisclosure
        tree={branchingSourceTree}
        hardware={sourceHardware}
        hardwareError={new Error("Reconnect Garmin to load device details")}
        onRetryHardware={retry}
      />,
    );
    expect(screen.getByText("Reconnect Garmin to load device details")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(retry).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Edge 530 Lineage" }));
    expect(screen.getAllByText("Edge 530")).toHaveLength(2);
  });

  it("keeps pending device details reachable without a source tree", () => {
    const { rerender } = render(
      <ActivitySourceDisclosure tree={{ primary: null, otherSources: [] }} hardwareLoading />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Lineage" }));
    expect(screen.getByRole("status", { name: "Loading device details." })).toBeVisible();
    rerender(
      <ActivitySourceDisclosure
        tree={{ primary: null, otherSources: [] }}
        hardware={sourceHardware}
        hardwareLoading
      />,
    );
    expect(screen.getByText("Edge 530")).toBeVisible();
    expect(screen.queryByRole("status", { name: "Loading device details." })).toBeNull();
  });

  it("only offers source details when the tree contains source records", () => {
    const { container, rerender } = render(
      <ActivitySourceDisclosure tree={{ primary: null, otherSources: [] }} />,
    );
    expect(container).toBeEmptyDOMElement();

    rerender(<ActivitySourceDisclosure tree={branchingSourceTree} />);
    expect(screen.getByRole("button", { name: "Garmin Connect Lineage" })).toBeVisible();

    rerender(<ActivitySourceDisclosure tree={{ primary: null, otherSources: [] }} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the Garmin model thumbnail in the inline control", () => {
    render(
      <ActivitySourceDisclosure
        tree={{
          primary: {
            id: "garmin-record",
            providerId: "garmin",
            sourceName: "Forerunner 965",
            label: "Forerunner 965",
            description: null,
            url: null,
            children: [],
          },
          otherSources: [],
        }}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Forerunner 965 Lineage" });
    expect(trigger.querySelector("img")).toHaveAttribute(
      "src",
      expect.stringContaining("010-02809-00"),
    );
    expect(trigger.querySelector("img")).toHaveAttribute("width", "18");
    fireEvent.click(trigger);
    expect(screen.getAllByText("Forerunner 965")).toHaveLength(2);
  });

  it("expands inline with one primary root and distinct transfer branches", () => {
    render(<ActivitySourceDisclosure tree={branchingSourceTree} />);
    const trigger = screen.getByRole("button", { name: "Garmin Connect Lineage" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger.querySelectorAll("img")).toHaveLength(1);
    expect(screen.queryByText("Strava")).toBeNull();
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    const content = document.getElementById(trigger.getAttribute("aria-controls") ?? "");
    expect(content).toBeVisible();
    expect(screen.getAllByText("Garmin Connect")).toHaveLength(2);
    const strava = screen.getByRole("link", { name: "Strava" }).closest("li");
    expect(strava).not.toBeNull();
    if (!strava) throw new Error("Missing Strava tree node");
    expect(screen.getAllByText("Apple Health")).toHaveLength(2);
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Strava")).toBeNull();
  });

  it("retains disconnected components outside the primary tree", () => {
    render(<ActivitySourceDisclosure tree={branchingSourceTree} />);
    fireEvent.click(screen.getByRole("button", { name: "Garmin Connect Lineage" }));
    const others = screen.getByRole("region", { name: "Other" });
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
    fireEvent.click(screen.getByRole("button", { name: "Lineage" }));
    expect(screen.getByText("WHOOP")).toBeVisible();
  });

  it("keeps focus on the native disclosure button and gives each region a unique id", () => {
    render(
      <>
        <ActivitySourceDisclosure tree={branchingSourceTree} />
        <ActivitySourceDisclosure tree={branchingSourceTree} />
      </>,
    );
    const triggers = screen.getAllByRole("button", { name: "Garmin Connect Lineage" });
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
    fireEvent.click(screen.getByRole("button", { name: "Garmin Connect Lineage" }));
    expect(screen.getByRole("link", { name: "Strava" })).toHaveAttribute(
      "href",
      "https://www.strava.com/activities/123",
    );
    expect(within(screen.getByRole("link", { name: "Strava" })).getByText("↗")).toHaveAttribute(
      "aria-hidden",
      "true",
    );
    for (const label of screen.getAllByText("Apple Health")) {
      expect(label.parentElement?.querySelectorAll("img")).toHaveLength(1);
    }
    const primaryLink = screen.getByRole("link", { name: "Garmin Connect" });
    expect(primaryLink).toHaveTextContent("Garmin Connect");
    expect(primaryLink).toHaveAttribute("href", "https://connect.garmin.com/modern/activity/123");
  });
});
