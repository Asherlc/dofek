/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  branchingSourceTree,
  recognizedWatchHardware,
  recognizedWatchSourceTree,
  sourceHardware,
  walkingSourceTree,
} from "./ActivitySourceDisclosure.fixtures.ts";
import { ActivitySourceDisclosure } from "./ActivitySourceDisclosure.tsx";

afterEach(cleanup);

describe("ActivitySourceDisclosure", () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Strava Sources" }));
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
    const trigger = screen.getByRole("button", { name: "WHOOP (Cloud) Sources" });
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
      name: "Apple Watch Series 7 (GPS + Cellular, 45mm) Sources",
    });
    expect(screen.queryByText("Asher’s Apple Watch")).toBeNull();
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByText("Apple Watch Series 7 (GPS + Cellular, 45mm)")).toHaveLength(1);
    expect(screen.getAllByText("Garmin Forerunner 955")).toHaveLength(1);
    expect(screen.getByText("Asher’s Apple Watch")).toBeVisible();
    expect(screen.getByText("Apple Health")).toBeVisible();
    const garmin = screen.getByRole("link", { name: "Garmin Forerunner 955" }).closest("li");
    if (!garmin) throw new Error("Missing Garmin source branch");
    expect(within(garmin).getByText("19.18")).toBeVisible();
    expect(within(garmin).queryByText("Asher’s Apple Watch")).toBeNull();
    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Asher’s Apple Watch")).toBeNull();
    expect(screen.getByText("Apple Watch Series 7 (GPS + Cellular, 45mm)")).toBeVisible();
  });
  it("reveals device facts with their source branch through the Sources control", () => {
    render(<ActivitySourceDisclosure tree={branchingSourceTree} hardware={sourceHardware} />);
    const trigger = screen.getByRole("button", { name: "Garmin Connect Sources" });
    expect(screen.queryByText("12345678")).toBeNull();
    fireEvent.click(trigger);
    expect(screen.getByText("12345678")).toBeVisible();
    const strava = screen.getByRole("link", { name: "Strava" }).closest("li");
    if (!strava) throw new Error("Missing Strava branch");
    expect(within(strava).getByText("Measured")).toBeVisible();
    expect(within(strava).queryByText("12345678")).toBeNull();
    const others = screen.getByRole("region", { name: "Additional sources" });
    expect(within(others).queryByText("12345678")).toBeNull();
    fireEvent.click(trigger);
    expect(screen.queryByText("12345678")).toBeNull();
  });

  it("nests reported device metadata beneath its reporting provider", () => {
    render(<ActivitySourceDisclosure tree={branchingSourceTree} hardware={sourceHardware} />);
    fireEvent.click(screen.getByRole("button", { name: "Garmin Connect Sources" }));
    const peloton = screen.getByText("Peloton").closest("li");
    if (!peloton) throw new Error("Missing Peloton branch");
    const child = within(peloton).getByText("Whoop").closest("li");
    expect(child?.parentElement?.closest("li")).toBe(peloton);
  });

  it("places watch model and firmware beneath the watch rather than its importing app", () => {
    render(
      <ActivitySourceDisclosure
        tree={walkingSourceTree}
        hardware={{
          items: [
            {
              ...sourceHardware.items[0],
              id: "watch",
              activityId: "apple-record",
              providerId: "apple_health",
              sourceName: "Asher’s Apple Watch",
              role: "recorder",
              label: "Apple Watch",
              model: "Apple Watch Ultra 3",
              manufacturer: "Apple",
              evidence: "Reported hardware",
              details: [{ label: "Firmware", value: "26.0" }],
            },
          ],
          power: [],
        }}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Asher’s Apple Watch Sources" });
    fireEvent.click(trigger);
    expect(screen.getByText("Apple Watch Ultra 3")).toBeVisible();
    expect(screen.getByText("26.0")).toBeVisible();
    const appleHealth = screen.getByText("Apple Health").closest("li");
    if (!appleHealth) throw new Error("Missing Apple Health branch");
    expect(within(appleHealth).queryByText("26.0")).toBeNull();
  });

  it("offers device facts when no source tree is available", () => {
    render(
      <ActivitySourceDisclosure
        tree={{ primary: null, otherSources: [] }}
        hardware={sourceHardware}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    expect(screen.getByText("12345678")).toBeVisible();
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
    fireEvent.click(screen.getByRole("button", { name: "Garmin Connect Sources" }));
    expect(screen.getByText("12345678")).toBeVisible();
  });

  it("keeps pending device details reachable without a source tree", () => {
    const { rerender } = render(
      <ActivitySourceDisclosure tree={{ primary: null, otherSources: [] }} hardwareLoading />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    expect(screen.getByRole("status", { name: "Loading device details." })).toBeVisible();
    rerender(
      <ActivitySourceDisclosure
        tree={{ primary: null, otherSources: [] }}
        hardware={sourceHardware}
        hardwareLoading
      />,
    );
    expect(screen.getByText("12345678")).toBeVisible();
    expect(screen.queryByRole("status", { name: "Loading device details." })).toBeNull();
  });

  it("only offers source details when the tree contains source records", () => {
    const { container, rerender } = render(
      <ActivitySourceDisclosure tree={{ primary: null, otherSources: [] }} />,
    );
    expect(container).toBeEmptyDOMElement();

    rerender(<ActivitySourceDisclosure tree={branchingSourceTree} />);
    expect(screen.getByRole("button", { name: "Garmin Connect Sources" })).toBeVisible();

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
    const trigger = screen.getByRole("button", { name: "Forerunner 965 Sources" });
    expect(trigger.querySelector("img")).toHaveAttribute(
      "src",
      expect.stringContaining("010-02809-00"),
    );
    expect(trigger.querySelector("img")).toHaveAttribute("width", "18");
    fireEvent.click(trigger);
    expect(screen.getAllByText("Forerunner 965")).toHaveLength(1);
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
    fireEvent.click(screen.getByRole("button", { name: "Garmin Connect Sources" }));
    const others = screen.getByRole("region", { name: "Additional sources" });
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
    const primaryLink = screen.getByRole("link", { name: "View activity for Garmin Connect" });
    expect(primaryLink).toHaveTextContent("View activity");
    expect(primaryLink).toHaveAttribute("href", "https://connect.garmin.com/modern/activity/123");
  });
});
