import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Linking } from "react-native";
import { userEvent } from "storybook/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { branchingActivitySourceTree } from "../app-fixtures/activity-source-tree";
import { captureException } from "../lib/telemetry";
import { ActivitySourceDisclosure } from "./ActivitySourceDisclosure";

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
  beforeEach(() => vi.clearAllMocks());

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
    expect(screen.queryByText("Imported from Hang Ten")).toBeNull();
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    const controlledId = trigger.getAttribute("aria-controls");
    expect(controlledId).toBeTruthy();
    expect(document.getElementById(controlledId ?? "")?.textContent).toContain("Apple Health");
    expect(screen.getAllByText("Hang Ten")).toHaveLength(1);
    expect(screen.getByText("Recording app reported by Apple Health")).toBeDefined();
    expect(screen.getByText("Apple Health")).toBeDefined();
    expect(screen.getAllByText("Strava")).toHaveLength(2);
    expect(screen.getByText("Imported from Apple Health")).toBeDefined();
    expect(screen.getAllByText("Imported from Hang Ten")).toHaveLength(2);
    expect(screen.getByText("Other matching sources")).toBeDefined();
    expect(screen.getByText("WHOOP")).toBeDefined();
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Imported from Hang Ten")).toBeNull();
  });

  it("shows disconnected source components when the primary is unresolved", () => {
    render(
      <ActivitySourceDisclosure
        tree={{ primary: null, otherSources: branchingActivitySourceTree.primary?.children ?? [] }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    expect(screen.getByText("Other matching sources")).toBeDefined();
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
});
