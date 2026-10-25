import { act, fireEvent, render, screen } from "@testing-library/react";
import { Linking } from "react-native";
import { userEvent } from "storybook/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { garminActivitySourceTree } from "../../app-fixtures/activity-source-tree";
import { ActivityDetailHeader } from "./ActivityDetailHeader";
import { detailHeaderActivity, removedDetailHeaderActivity } from "./ActivityDetailHeader.fixtures";

vi.mock("react-native", async () => {
  const web = await vi.importActual<typeof import("react-native")>("react-native-web");
  return { ...web, Linking: { ...web.Linking, openURL: vi.fn(() => Promise.resolve()) } };
});

vi.mock("../ProviderLogo", () => ({ ProviderLogo: () => null }));

describe("ActivityDetailHeader", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps the activity identity with an inline tree of distinct source branches", () => {
    render(<ActivityDetailHeader activity={detailHeaderActivity} />);

    expect(screen.getByText("Morning Ride")).toBeDefined();
    expect(screen.getByText(/Tue, Apr 14, 2026 at 3:00 AM/)).toBeDefined();
    const trigger = screen.getByRole("button", { name: "Sources: Garmin Edge 530" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Apple Health")).toBeNull();

    fireEvent.click(trigger);

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByText("Garmin Edge 530")).toHaveLength(1);
    expect(screen.getAllByText("Apple Health")).toHaveLength(2);
    expect(screen.getByText("Imported from Strava")).toBeDefined();
    expect(screen.getByText("Other matching sources")).toBeDefined();
    expect(screen.getByText("WHOOP")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "View source for Strava" }));
    expect(Linking.openURL).toHaveBeenCalledWith("https://www.strava.com/activities/123");
    expect(screen.getByText("Morning Ride")).toBeDefined();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
  });

  it.each(["{Enter}", " "])("expands and collapses with the real RN-web %j key", async (key) => {
    render(<ActivityDetailHeader activity={detailHeaderActivity} />);
    const trigger = screen.getByRole("button", { name: "Sources: Garmin Edge 530" });
    act(() => trigger.focus());
    await act(async () => userEvent.keyboard(key));
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(trigger);
    await act(async () => userEvent.keyboard(key));
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger);
  });

  it("keeps activity identity when there are no external source records", () => {
    render(
      <ActivityDetailHeader
        activity={{ ...detailHeaderActivity, sourceTree: { primary: null, otherSources: [] } }}
      />,
    );
    expect(screen.getByText("Morning Ride")).toBeDefined();
    expect(screen.queryByRole("button", { name: /Sources/ })).toBeNull();
  });

  it("expands disconnected sources when recording attribution is unresolved", () => {
    render(
      <ActivityDetailHeader
        activity={{
          ...detailHeaderActivity,
          sourceTree: { primary: null, otherSources: garminActivitySourceTree.otherSources },
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Sources" }));
    expect(screen.getByText("Other matching sources")).toBeDefined();
    expect(screen.getByText("WHOOP")).toBeDefined();
  });

  it("preserves activity removal details while removed source records have no action", () => {
    render(<ActivityDetailHeader activity={removedDetailHeaderActivity} />);
    expect(screen.getByText("Removed from provider sync")).toBeDefined();
    expect(screen.getByText("Removed")).toBeDefined();
    expect(screen.getByText(/Mar 5, 2026/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Sources: Garmin Edge 530" }));
    expect(screen.getByText("Removed from provider sync on March 5, 2026")).toBeDefined();
    expect(screen.queryByRole("button", { name: "View source for Garmin Edge 530" })).toBeNull();
  });
});
