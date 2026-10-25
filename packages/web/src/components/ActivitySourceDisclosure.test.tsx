/** @vitest-environment jsdom */
import type { ActivityOrigin } from "@dofek/providers/activity-origin";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ActivitySourceDisclosure } from "./ActivitySourceDisclosure.tsx";

const origin: ActivityOrigin = {
  status: "resolved",
  memberActivityId: "00000000-0000-4000-8000-000000000001",
  providerId: "apple_health",
  sourceName: "Hang Ten",
};
afterEach(cleanup);

describe("ActivitySourceDisclosure", () => {
  it("shows the Garmin recording model in its compact control and details", () => {
    render(
      <ActivitySourceDisclosure
        origin={{ ...origin, providerId: "garmin", sourceName: "Forerunner 965" }}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Activity source: Garmin" });
    expect(trigger.querySelector("img")).toHaveAttribute(
      "src",
      expect.stringContaining("010-02809-00"),
    );
    expect(trigger.querySelector("img")).toHaveAttribute("width", "18");
    fireEvent.click(trigger);
    const details = screen.getByRole("dialog", { name: "Activity source" });
    expect(details.querySelector("img")).toHaveAttribute(
      "src",
      expect.stringContaining("010-02809-00"),
    );
    expect(within(details).getByText("Garmin")).toBeVisible();
    expect(within(details).queryByText("Imported via")).toBeNull();
  });

  it("opens recording and import roles from a clean recording-only logo", () => {
    render(<ActivitySourceDisclosure origin={origin} />);
    const trigger = screen.getByRole("button", { name: "Activity source: Hang Ten" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger.querySelectorAll("img")).toHaveLength(1);
    expect(trigger.querySelector("img")).toHaveAttribute("src", "/logos/hang-ten.png");
    expect(trigger).toHaveTextContent("");
    fireEvent.click(trigger);
    const details = screen.getByRole("dialog", { name: "Activity source" });
    expect(within(details).getByText("Recorded in")).toBeVisible();
    expect(within(details).getByText("Hang Ten")).toBeVisible();
    expect(within(details).getByText("Imported via")).toBeVisible();
    expect(within(details).getByText("Apple Health")).toBeVisible();
    fireEvent.click(within(details).getByRole("button", { name: "Close activity source" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("dismisses with Escape and returns focus to its trigger", async () => {
    render(<ActivitySourceDisclosure origin={origin} />);
    const trigger = screen.getByRole("button", { name: "Activity source: Hang Ten" });
    trigger.focus();
    fireEvent.click(trigger);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Close activity source" })).toHaveFocus(),
    );
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("dismisses when focus moves outside", async () => {
    render(
      <>
        <ActivitySourceDisclosure origin={origin} />
        <button type="button">Outside</button>
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Activity source: Hang Ten" }));
    screen.getByRole("button", { name: "Outside" }).focus();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("shows one row for direct WHOOP", () => {
    render(
      <ActivitySourceDisclosure origin={{ ...origin, providerId: "whoop", sourceName: null }} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Activity source: WHOOP (Cloud)" }));
    expect(screen.getByText("WHOOP (Cloud)")).toBeVisible();
    expect(screen.queryByText("Imported via")).toBeNull();
  });

  it("omits an unresolved source control", () => {
    render(
      <ActivitySourceDisclosure
        origin={{ status: "unresolved", candidateMemberActivityIds: [] }}
      />,
    );
    expect(screen.queryByRole("button")).toBeNull();
  });
});
