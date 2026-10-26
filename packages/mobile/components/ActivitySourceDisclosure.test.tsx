import type { ActivityHardware } from "@dofek/providers/activity-hardware";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Linking } from "react-native";
import { userEvent } from "storybook/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  branchingActivitySourceTree,
  recognizedWatchHardware,
  recognizedWatchSourceTree,
  walkingActivitySourceHardware,
  walkingActivitySourceTree,
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
    const trigger = screen.getByRole("button", { name: "Sources: WHOOP (Cloud)" });
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
      name: "Sources: Apple Watch Series 7 (GPS + Cellular, 45mm)",
    });
    expect(screen.queryByText("Device name: Asher’s Apple Watch")).toBeNull();
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByText("Apple Watch Series 7 (GPS + Cellular, 45mm)")).toHaveLength(1);
    expect(screen.getAllByText("Garmin Forerunner 955")).toHaveLength(1);
    expect(screen.getByText("Device name: Asher’s Apple Watch")).toBeDefined();
    expect(screen.getByText("Apple Health")).toBeDefined();
    const garminLink = screen.getByRole("button", {
      name: "View source for Garmin Forerunner 955",
    });
    const garmin = garminLink.parentElement?.parentElement?.parentElement?.parentElement;
    if (!garmin) throw new Error("Missing Garmin source branch");
    expect(within(garmin).getByText("Firmware: 19.18")).toBeDefined();
    expect(within(garmin).queryByText("Device name: Asher’s Apple Watch")).toBeNull();
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Device name: Asher’s Apple Watch")).toBeNull();
    expect(screen.getByText("Apple Watch Series 7 (GPS + Cellular, 45mm)")).toBeDefined();
  });

  it("only offers source details when the tree contains source records", () => {
    const { container, rerender } = render(
      <ActivitySourceDisclosure tree={{ primary: null, otherSources: [] }} />,
    );
    expect(container.innerHTML).toBe("");

    rerender(<ActivitySourceDisclosure tree={branchingActivitySourceTree} />);
    expect(screen.getByRole("button", { name: "Sources: Hang Ten" })).toBeDefined();

    rerender(<ActivitySourceDisclosure tree={{ primary: null, otherSources: [] }} />);
    expect(container.innerHTML).toBe("");
  });

  it("toggles an inline tree with a single primary root and accessible controls", () => {
    render(<ActivitySourceDisclosure tree={branchingActivitySourceTree} />);
    const trigger = screen.getByRole("button", { name: "Sources: Hang Ten" });
    expect(getComputedStyle(trigger).minHeight).toBe("44px");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.textContent).toContain("Hang Ten");
    expect(trigger.textContent).toContain("Sources");
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
    expect(screen.getAllByText("Hang Ten")).toHaveLength(1);
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
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    expect(screen.getByText("Apple Health")).toBeDefined();
    expect(screen.getAllByText("Strava")).toHaveLength(2);
  });

  it("opens the server-projected source URL independently of expansion", () => {
    render(<ActivitySourceDisclosure tree={branchingActivitySourceTree} />);
    const trigger = screen.getByRole("button", { name: "Sources: Hang Ten" });
    fireEvent.click(trigger);
    fireEvent.click(screen.getAllByRole("button", { name: "View source for Strava" })[0]);
    expect(Linking.openURL).toHaveBeenCalledWith("https://www.strava.com/activities/123");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it("names source controls with their visible action and provider", () => {
    render(<ActivitySourceDisclosure tree={branchingActivitySourceTree} />);
    fireEvent.click(screen.getByRole("button", { name: "Sources: Hang Ten" }));
    const controls = screen.getAllByRole("button", { name: "View source for Strava" });
    expect(controls).toHaveLength(2);
    for (const control of controls) {
      expect(control.textContent).toContain("View source");
    }
  });

  it.each(["Enter", " "])("opens a source with the real RN-web %j key", async (key) => {
    render(<ActivitySourceDisclosure tree={branchingActivitySourceTree} />);
    const trigger = screen.getByRole("button", { name: "Sources: Hang Ten" });
    fireEvent.click(trigger);
    const source = screen.getAllByRole("button", { name: "View source for Strava" })[0];
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
    fireEvent.click(screen.getByRole("button", { name: "Sources: Hang Ten" }));
    fireEvent.click(screen.getAllByRole("button", { name: "View source for Strava" })[0]);
    await waitFor(() => expect(captureException).toHaveBeenCalledWith(error));
    expect(screen.getByText("Cannot open source")).toBeDefined();
  });

  it("opens recorder, nested sensor, and unmatched facts with the source tree", () => {
    render(<ActivitySourceDisclosure tree={branchingActivitySourceTree} hardware={hardware} />);
    const trigger = screen.getByRole("button", { name: "Sources: Hang Ten" });
    expect(screen.queryByText("Serial number: WATCH-123")).toBeNull();
    expect(screen.queryByText("Heart rate strap")).toBeNull();
    fireEvent.click(trigger);
    const content = document.getElementById(trigger.getAttribute("aria-controls") ?? "");
    if (!content) throw new Error("Source disclosure content is missing");
    expect(within(content).getByText("Serial number: WATCH-123")).toBeDefined();
    expect(screen.getAllByRole("button", { name: "View source for Strava" })).toHaveLength(2);
  });

  it("places Apple Watch facts at the device root and nests Whoop under Peloton", () => {
    render(
      <ActivitySourceDisclosure
        tree={walkingActivitySourceTree}
        hardware={walkingActivitySourceHardware}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Sources: Asher’s Apple Watch" });
    fireEvent.click(trigger);
    const content = document.getElementById(trigger.getAttribute("aria-controls") ?? "");
    const root = content?.firstElementChild;
    const serialFacts = screen.getByText("Serial number: WATCH-123").parentElement;
    expect(serialFacts?.parentElement).toBe(root);
    const appleHealth = screen.getByText("Apple Health").parentElement;
    if (!appleHealth) throw new Error("Apple Health source content is missing");
    expect(within(appleHealth).queryByText("Serial number: WATCH-123")).toBeNull();
    const peloton = screen.getByText("Peloton").parentElement?.parentElement?.parentElement;
    if (!peloton) throw new Error("Peloton source branch is missing");
    expect(within(peloton).getByText("Whoop")).toBeDefined();
  });

  it("keeps nested hardware on its exact source record and preserves unmatched metadata", () => {
    render(<ActivitySourceDisclosure tree={branchingActivitySourceTree} hardware={hardware} />);
    fireEvent.click(screen.getByRole("button", { name: "Sources: Hang Ten" }));
    const stravaLink = screen.getAllByRole("button", { name: "View source for Strava" })[0];
    const stravaSource = stravaLink?.parentElement?.parentElement?.parentElement?.parentElement;
    if (!stravaSource) throw new Error("Strava source content is missing");
    expect(within(stravaSource).getByText("Firmware: 3.2")).toBeDefined();
    expect(within(stravaSource).getByText("Power: Measured")).toBeDefined();
    const peloton = screen.getByText("Peloton").parentElement?.parentElement?.parentElement;
    if (!peloton) throw new Error("Peloton source branch is missing");
    expect(within(peloton).getByText("Peloton Bike+")).toBeDefined();
    expect(within(peloton).getByText("Platform: Peloton Bike")).toBeDefined();
    expect(within(peloton).getByText("Power: Measured")).toBeDefined();
    expect(screen.getAllByText("Firmware: 3.2")).toHaveLength(1);
  });

  it("offers hardware-only sources and hides their facts again when collapsed", () => {
    render(
      <ActivitySourceDisclosure tree={{ primary: null, otherSources: [] }} hardware={hardware} />,
    );
    const trigger = screen.getByRole("button", { name: "Sources" });
    fireEvent.click(trigger);
    expect(screen.getByText("Serial number: WATCH-123")).toBeDefined();
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Serial number: WATCH-123")).toBeNull();
  });

  it("shows actionable refresh errors while collapsed and retains cached facts on expansion", () => {
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
    fireEvent.click(screen.getByRole("button", { name: "Sources: Hang Ten" }));
    expect(screen.getByText("Serial number: WATCH-123")).toBeDefined();
    expect(screen.queryByTestId("query-state-loading")).toBeNull();
  });

  it("keeps hardware loading and failures reachable without source records", () => {
    const view = render(
      <ActivitySourceDisclosure tree={{ primary: null, otherSources: [] }} hardwareLoading />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    expect(screen.getByTestId("query-state-loading")).toBeDefined();
    view.rerender(
      <ActivitySourceDisclosure
        tree={{ primary: null, otherSources: [] }}
        hardwareError={new Error("Reconnect Peloton, then retry.")}
      />,
    );
    expect(screen.getByRole("button", { name: "Sources" })).toBeDefined();
    expect(screen.getByRole("alert").textContent).toContain("Reconnect Peloton");
  });
});
