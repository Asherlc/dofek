// @vitest-environment jsdom
import type { ActivityMetricSource } from "@dofek/providers/activity-metric-source";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityMetricSourcePicker } from "./ActivityMetricSourcePicker.tsx";

const sources: ActivityMetricSource[] = [
  {
    id: "watch-recording",
    label: "Asher’s Apple Watch (Apple Health)",
    presentation: {
      displayName: "Asher’s Apple Watch",
      providerId: "apple_health",
      sourceName: "Asher’s Apple Watch",
      attribution: { kind: "apple_health", label: "via Apple Health" },
    },
  },
  {
    id: "cloud-recording",
    label: "WHOOP (Cloud)",
    presentation: {
      displayName: "WHOOP",
      providerId: "whoop",
      sourceName: null,
      attribution: { kind: "cloud", label: "via WHOOP Cloud" },
    },
  },
  {
    id: "bluetooth-recording",
    label: "WHOOP (Bluetooth)",
    presentation: {
      displayName: "WHOOP",
      providerId: "whoop",
      sourceName: null,
      attribution: { kind: "bluetooth", label: "via Bluetooth" },
    },
  },
];

function PickerHarness({ initialId = "watch-recording" }: { initialId?: string }) {
  const [selectedId, setSelectedId] = useState(initialId);
  return (
    <>
      <ActivityMetricSourcePicker
        label="Heart Rate"
        sources={sources}
        selectedId={selectedId}
        onChange={setSelectedId}
      />
      <output aria-label="Selected recording">{selectedId}</output>
    </>
  );
}

afterEach(cleanup);

describe("ActivityMetricSourcePicker", () => {
  it("opens an anchored dropdown with attribution icons in each option", () => {
    render(<PickerHarness />);
    fireEvent.click(screen.getByRole("button", { name: /Heart Rate source/ }));
    const dropdown = screen.getByRole("dialog", { name: "Heart Rate source" });
    expect(dropdown).toHaveAttribute("data-side", "bottom");
    expect(dropdown).not.toHaveAttribute("aria-modal", "true");
    for (const source of sources) {
      const option = screen.getByRole("radio", { name: source.label }).closest("label");
      expect(option?.textContent).toBe(
        source.id === "watch-recording" ? "Asher’s Apple Watch" : "",
      );
      expect(
        option?.querySelector(`[title="${source.presentation.attribution?.label}"]`),
      ).not.toBeNull();
      expect(option).not.toHaveTextContent(source.label);
    }
  });

  it("shows a compact name and logos while exposing full source attribution", () => {
    render(<PickerHarness />);
    const trigger = screen.getByRole("button", {
      name: "Heart Rate source: Asher’s Apple Watch (Apple Health)",
    });
    expect(trigger.textContent).toBe("Asher’s Apple Watch");
    expect(trigger).toHaveAttribute("aria-haspopup", "dialog");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger.querySelector('img[src="/logos/apple-watch.svg"]')).not.toBeNull();
    expect(trigger.querySelector('img[src="/logos/apple_health.png"]')).not.toBeNull();
    expect(trigger.querySelectorAll('img[src="/logos/apple_health.png"]')).toHaveLength(1);
  });

  it("dismisses on outside interaction while leaving the page interactive", async () => {
    render(
      <>
        <PickerHarness />
        <button type="button">Other control</button>
      </>,
    );
    const trigger = screen.getByRole("button", { name: /Heart Rate source/ });
    fireEvent.click(trigger);
    const outside = screen.getByRole("button", { name: "Other control" });
    outside.focus();
    await waitFor(() => expect(trigger).toHaveAttribute("aria-expanded", "false"));
    expect(outside).toHaveFocus();
    expect(screen.getByLabelText("Selected recording")).toHaveTextContent("watch-recording");
  });

  it("offers full labels and switches between duplicate display names by stable ID", async () => {
    render(<PickerHarness initialId="cloud-recording" />);
    const trigger = screen.getByRole("button", { name: /Heart Rate source: WHOOP \(Cloud\)/ });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Heart Rate source" });
    const cloud = within(dialog).getByRole("radio", { name: "WHOOP (Cloud)" });
    const bluetooth = within(dialog).getByRole("radio", {
      name: "WHOOP (Bluetooth)",
    });
    expect(cloud).toBeChecked();
    expect(bluetooth).not.toBeChecked();
    expect(within(dialog).getByText("Asher’s Apple Watch")).toBeVisible();
    await waitFor(() => expect(cloud).toHaveFocus());
    fireEvent.click(bluetooth);
    expect(screen.getByLabelText("Selected recording")).toHaveTextContent("bluetooth-recording");
    expect(screen.getByRole("button", { name: /WHOOP \(Bluetooth\)/ }).textContent).toBe("");
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it.each(["Escape", "Enter"])(
    "supports arrow selection and %s with focus returned to the trigger",
    async (dismissal) => {
      render(<PickerHarness initialId="cloud-recording" />);
      const trigger = screen.getByRole("button", { name: /Heart Rate source/ });
      trigger.focus();
      fireEvent.click(trigger);
      const cloud = screen.getByRole("radio", { name: "WHOOP (Cloud)" });
      await waitFor(() => expect(cloud).toHaveFocus());
      fireEvent.keyDown(cloud, { key: "ArrowRight" });
      const bluetooth = screen.getByRole("radio", { name: "WHOOP (Bluetooth)" });
      expect(bluetooth).toHaveFocus();
      expect(bluetooth).toBeChecked();
      expect(screen.getByLabelText("Selected recording")).toHaveTextContent("bluetooth-recording");
      fireEvent.keyDown(bluetooth, { key: "ArrowDown" });
      const watch = screen.getByRole("radio", {
        name: "Asher’s Apple Watch (Apple Health)",
      });
      expect(watch).toHaveFocus();
      expect(watch).toBeChecked();
      fireEvent.keyDown(watch, { key: "ArrowUp" });
      expect(bluetooth).toHaveFocus();
      expect(bluetooth).toBeChecked();
      fireEvent.keyDown(bluetooth, { key: "ArrowLeft" });
      expect(cloud).toHaveFocus();
      expect(cloud).toBeChecked();
      fireEvent.keyDown(cloud, { key: dismissal });
      await waitFor(() => expect(trigger).toHaveFocus());
      expect(trigger).toHaveAttribute("aria-expanded", "false");
    },
  );

  it("shows the compact device name and retains full provenance in the tooltip", () => {
    render(
      <ActivityMetricSourcePicker
        label="Power"
        sources={[
          {
            id: "fit-file",
            label: "Garmin Edge 1050 · Recorded by Garmin Edge 1050 · FIT file creator Garmin",
            presentation: {
              displayName: "Garmin Edge 1050",
              providerId: "garmin",
              sourceName: "Edge 1050",
              attribution: null,
            },
          },
        ]}
        selectedId="fit-file"
        onChange={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Power source/ }));
    const option = screen.getByRole("radio", {
      name: "Garmin Edge 1050 · Recorded by Garmin Edge 1050 · FIT file creator Garmin",
    });
    expect(option.closest("label")).toHaveAttribute(
      "title",
      "Garmin Edge 1050 · Recorded by Garmin Edge 1050 · FIT file creator Garmin",
    );
    expect(option.closest("label")?.textContent).toBe("Garmin Edge 1050");
  });

  it("uses provider logos with device names and keeps complete source descriptions accessible", () => {
    const pelotonSources: ActivityMetricSource[] = [
      {
        id: "peloton",
        label: "Peloton",
        presentation: {
          displayName: "Peloton",
          providerId: "peloton",
          sourceName: null,
          attribution: null,
        },
      },
      {
        id: "strava",
        label: "Strava · recorded by Peloton Bike",
        presentation: {
          displayName: "Peloton Bike",
          providerId: "strava",
          sourceName: null,
          attribution: null,
        },
      },
      {
        id: "unknown",
        label: "Imported recording",
        presentation: {
          displayName: "Imported recording",
          providerId: "unknown-recorder",
          sourceName: null,
          attribution: null,
        },
      },
    ];
    render(
      <ActivityMetricSourcePicker
        label="Power"
        sources={pelotonSources}
        selectedId="peloton"
        onChange={() => {}}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Power source: Peloton" });
    expect(trigger.textContent).toBe("");
    expect(trigger).toHaveAttribute("title", "Peloton");
    expect(trigger.querySelector('img[src="/logos/peloton.svg"]')).not.toBeNull();
    fireEvent.click(trigger);
    const peloton = screen.getByRole("radio", { name: "Peloton" }).closest("label");
    expect(peloton?.textContent).toBe("");
    expect(peloton?.querySelector('img[src="/logos/peloton.svg"]')).not.toBeNull();
    const strava = screen
      .getByRole("radio", { name: "Strava · recorded by Peloton Bike" })
      .closest("label");
    expect(strava?.textContent).toBe("Peloton Bike");
    expect(strava).toHaveAttribute("title", "Strava · recorded by Peloton Bike");
    expect(strava?.querySelector('img[src="/logos/strava.svg"]')).not.toBeNull();
    expect(
      screen.getByRole("radio", { name: "Imported recording" }).closest("label"),
    ).toHaveTextContent("Imported recording");
  });
});
