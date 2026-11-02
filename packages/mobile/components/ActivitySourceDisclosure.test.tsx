import "@testing-library/jest-dom/vitest";
import type { ActivityHardware } from "@dofek/providers/activity-hardware";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Linking, Text } from "react-native";
import { userEvent } from "storybook/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  branchingActivitySourceTree,
  recognizedWatchHardware,
  recognizedWatchSourceTree,
} from "../app-fixtures/activity-source-tree";
import { captureException } from "../lib/telemetry";
import { ActivitySourceDisclosure } from "./ActivitySourceDisclosure";

const hardware: ActivityHardware = {
  items: [
    {
      id: "recorder",
      activityId: "hang-ten",
      providerId: "apple_health",
      sourceName: "Hang Ten",
      role: "recorder",
      label: "Apple Watch",
      manufacturer: "Apple",
      model: "Watch 7,3",
      evidence: "Hardware reported by HealthKit.",
      details: [{ label: "Serial number", value: "WATCH-123" }],
    },
    {
      id: "strap",
      activityId: "strava-health",
      providerId: "strava",
      sourceName: null,
      role: "sensor",
      label: "Heart rate strap",
      manufacturer: "Polar",
      model: "H10",
      evidence: "Observed sensor.",
      details: [{ label: "Firmware", value: "3.2" }],
    },
    {
      id: "category",
      activityId: "unmatched",
      providerId: "peloton",
      sourceName: null,
      role: "category",
      label: "Peloton Bike+",
      manufacturer: null,
      model: null,
      evidence: "Reported equipment category.",
      details: [{ label: "Platform", value: "Peloton Bike" }],
    },
  ],
  power: [
    {
      activityId: "strava-health",
      providerId: "strava",
      kind: "measured",
      label: "Strava reports power-meter data.",
    },
    {
      activityId: "unmatched",
      providerId: "peloton",
      kind: "measured",
      label: "Peloton reports measured power.",
    },
  ],
};

vi.mock("react-native", async () => {
  const web = await vi.importActual<typeof import("react-native")>("react-native-web");
  return { ...web, Linking: { ...web.Linking, openURL: vi.fn(() => Promise.resolve()) } };
});

vi.mock("../lib/telemetry", () => ({ captureException: vi.fn() }));
vi.mock("./ProviderLogo", () => ({
  ProviderLogo: ({ provider, sourceName }: { provider: string; sourceName?: string }) => (
    <span data-testid="provider-logo" data-provider={provider} data-source-name={sourceName} />
  ),
}));

describe("ActivitySourceDisclosure", () => {
  it("labels the original, sharing direction, and all other branches explicitly", () => {
    render(
      <ActivitySourceDisclosure
        tree={{
          ...branchingActivitySourceTree,
          otherSources: [
            branchingActivitySourceTree.otherSources,
            branchingActivitySourceTree.otherSources.map((node) => ({
              ...node,
              id: `another-${node.id}`,
            })),
          ].flat(),
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Lineage: Hang Ten" }));
    expect(screen.getByText("Original")).toBeVisible();
    expect(screen.getAllByText("Other")).toHaveLength(1);
    expect(screen.getAllByText("Shared to")).toHaveLength(3);
    expect(screen.getAllByText("WHOOP")).toHaveLength(2);
  });
  it("labels unknown origins without assigning a winner", () => {
    render(
      <ActivitySourceDisclosure
        tree={{ primary: null, otherSources: branchingActivitySourceTree.otherSources }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Lineage" }));
    expect(screen.getByText("Original unknown")).toBeVisible();
    expect(screen.getByRole("group", { name: "Available recordings" })).toBeVisible();
    expect(screen.getByText("WHOOP")).toBeDefined();
  });

  it("marks linked recordings visibly and preserves their separate notices", () => {
    const original = branchingActivitySourceTree.primary;
    if (!original) throw new Error("Missing original fixture");
    render(
      <ActivitySourceDisclosure
        tree={{
          primary: {
            ...original,
            url: "https://example.com/activity",
            description: "Provider recording notice",
            children: [],
          },
          otherSources: [],
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Lineage: Hang Ten" }));
    const link = screen.getByRole("button", { name: "View activity for Hang Ten" });
    expect(within(link).getByText("↗")).toBeVisible();
    expect(screen.getByText("Provider recording notice")).toBeVisible();
    expect(within(link).queryByText("Provider recording notice")).toBeNull();
  });

  it("opens header sources in a dismissible overlay and restores focus", async () => {
    render(
      <ActivitySourceDisclosure
        tree={branchingActivitySourceTree}
        heading={<Text>Morning Ride</Text>}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Lineage: Hang Ten" });
    act(() => trigger.focus());
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Lineage" });
    expect(within(dialog).getByText("Apple Health")).toBeDefined();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close lineage" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("Morning Ride")).toBeDefined();
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
    fireEvent.click(screen.getByRole("button", { name: "Lineage: Strava" }));
    expect(screen.getAllByLabelText(label)).toHaveLength(2);
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
    const trigger = screen.getByRole("button", { name: "Lineage: WHOOP (Cloud)" });
    expect(within(trigger).getByText("WHOOP")).toBeDefined();
    expect(trigger.querySelector('[data-icon="cloud-outline"]')).toBeTruthy();
  });

  beforeEach(() => vi.clearAllMocks());
  it("discloses recognized watch models once in their provenance branches", () => {
    render(
      <ActivitySourceDisclosure
        tree={recognizedWatchSourceTree}
        hardware={recognizedWatchHardware}
      />,
    );
    const trigger = screen.getByRole("button", {
      name: "Lineage: Apple Watch Series 7 (GPS + Cellular, 45mm)",
    });
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByText("Apple Watch Series 7 (GPS + Cellular, 45mm)")).toHaveLength(2);
    expect(screen.getAllByText("Garmin Forerunner 955")).toHaveLength(1);
    expect(screen.getByText("Apple Health")).toBeDefined();
    const garminLink = screen.getByRole("button", {
      name: "View activity for Garmin Forerunner 955",
    });
    const garmin = garminLink.parentElement?.parentElement?.parentElement?.parentElement;
    if (!garmin) throw new Error("Missing Garmin source branch");
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByText("Apple Watch Series 7 (GPS + Cellular, 45mm)")).toBeDefined();
  });

  it("only offers source details when the tree contains source records", () => {
    const { container, rerender } = render(
      <ActivitySourceDisclosure tree={{ primary: null, otherSources: [] }} />,
    );
    expect(container.innerHTML).toBe("");

    rerender(<ActivitySourceDisclosure tree={branchingActivitySourceTree} />);
    expect(screen.getByRole("button", { name: "Lineage: Hang Ten" })).toBeDefined();

    rerender(<ActivitySourceDisclosure tree={{ primary: null, otherSources: [] }} />);
    expect(container.innerHTML).toBe("");
  });

  it("toggles an inline tree with a single primary root and accessible controls", () => {
    render(<ActivitySourceDisclosure tree={branchingActivitySourceTree} />);
    const trigger = screen.getByRole("button", { name: "Lineage: Hang Ten" });
    expect(getComputedStyle(trigger).minHeight).toBe("44px");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.textContent).toContain("Hang Ten");
    expect(trigger.textContent).toContain("Lineage");
    expect(within(trigger).getByTestId("provider-logo").getAttribute("data-provider")).toBe(
      "hang-ten",
    );
    expect(
      within(trigger).getByTestId("provider-logo").getAttribute("data-source-name"),
    ).toBeNull();
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const controlledId = trigger.getAttribute("aria-controls");
    expect(controlledId).toBeTruthy();
    expect(document.getElementById(controlledId ?? "")?.textContent).toContain("Apple Health");
    expect(screen.getAllByText("Hang Ten")).toHaveLength(2);
    expect(screen.getByText("Apple Health")).toBeDefined();
    expect(screen.getAllByText("Strava")).toHaveLength(2);
    expect(screen.getByText("WHOOP")).toBeDefined();
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
  });

  it("shows disconnected source components when the primary is unresolved", () => {
    render(
      <ActivitySourceDisclosure
        tree={{ primary: null, otherSources: branchingActivitySourceTree.primary?.children ?? [] }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Lineage" }));
    expect(screen.getByText("Apple Health")).toBeDefined();
    expect(screen.getAllByText("Strava")).toHaveLength(2);
  });

  it("opens the server-projected source URL independently of expansion", () => {
    render(<ActivitySourceDisclosure tree={branchingActivitySourceTree} />);
    const trigger = screen.getByRole("button", { name: "Lineage: Hang Ten" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getAllByRole("button", { name: "View activity for Strava" })[0]);
    expect(Linking.openURL).toHaveBeenCalledWith("https://www.strava.com/activities/123");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("names source controls with their visible action and provider", () => {
    render(<ActivitySourceDisclosure tree={branchingActivitySourceTree} />);
    fireEvent.click(screen.getByRole("button", { name: "Lineage: Hang Ten" }));
    const controls = screen.getAllByRole("button", { name: "View activity for Strava" });
    expect(controls).toHaveLength(2);
    for (const control of controls) {
      expect(control.textContent).toContain("Strava");
    }
  });

  it.each(["Enter", " "])("opens a source with the real RN-web %j key", async (key) => {
    render(<ActivitySourceDisclosure tree={branchingActivitySourceTree} />);
    const trigger = screen.getByRole("button", { name: "Lineage: Hang Ten" });
    fireEvent.click(trigger);
    const source = screen.getAllByRole("button", { name: "View activity for Strava" })[0];
    expect(source).toBeDefined();
    if (!source) throw new Error("Missing Strava source control");
    act(() => source.focus());
    await act(async () => userEvent.keyboard(key === "Enter" ? "{Enter}" : " "));
    expect(Linking.openURL).toHaveBeenCalledWith("https://www.strava.com/activities/123");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("reports link failures and displays the failure to the user", async () => {
    const error = new Error("Cannot open source");
    vi.mocked(Linking.openURL).mockRejectedValueOnce(error);
    render(<ActivitySourceDisclosure tree={branchingActivitySourceTree} />);
    fireEvent.click(screen.getByRole("button", { name: "Lineage: Hang Ten" }));
    fireEvent.click(screen.getAllByRole("button", { name: "View activity for Strava" })[0]);
    await waitFor(() => expect(captureException).toHaveBeenCalledWith(error));
    expect(screen.getByText("Cannot open source")).toBeDefined();
  });

  it("offers hardware-only sources and collapses them", () => {
    render(
      <ActivitySourceDisclosure tree={{ primary: null, otherSources: [] }} hardware={hardware} />,
    );
    const trigger = screen.getByRole("button", { name: "Lineage" });
    fireEvent.click(trigger);
    expect(screen.getByText("Peloton Bike+")).toBeDefined();
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Peloton Bike+")).toBeNull();
  });

  it("shows actionable refresh errors while collapsed and retains cached devices on expansion", () => {
    const onRetry = vi.fn();
    render(
      <ActivitySourceDisclosure
        tree={branchingActivitySourceTree}
        hardware={hardware}
        hardwareLoading
        hardwareError={new Error("Reconnect Apple Health, then retry this activity.")}
        onRetryHardware={onRetry}
      />,
    );
    expect(screen.getByRole("alert").textContent).toContain("Reconnect Apple Health");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(onRetry).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Lineage: Hang Ten" }));
    expect(screen.getByText("Peloton Bike+")).toBeDefined();
    expect(screen.queryByTestId("query-state-loading")).toBeNull();
  });

  it("keeps hardware loading and failures reachable without source records", () => {
    const view = render(
      <ActivitySourceDisclosure tree={{ primary: null, otherSources: [] }} hardwareLoading />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Lineage" }));
    expect(screen.getByTestId("query-state-loading")).toBeDefined();
    view.rerender(
      <ActivitySourceDisclosure
        tree={{ primary: null, otherSources: [] }}
        hardwareError={new Error("Reconnect Peloton, then retry.")}
      />,
    );
    expect(screen.getByRole("button", { name: "Lineage" })).toBeDefined();
    expect(screen.getByRole("alert").textContent).toContain("Reconnect Peloton");
  });
});
