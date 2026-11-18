// @vitest-environment jsdom
import {
  type ActivityMetricSource,
  activityMetricSourcePresentation,
  activityMetricSourceSchema,
} from "@dofek/providers/activity-metric-source";
import { providerSourceLabel } from "@dofek/providers/providers";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityMetricSourcePicker } from "./ActivityMetricSourcePicker.tsx";

const whoopBleSourceFor = (deviceId: string) => {
  const providerId = "whoop_ble";
  const label = providerSourceLabel(providerId, deviceId);
  return activityMetricSourceSchema.parse({
    id: JSON.stringify([providerId, deviceId]),
    label,
    presentation: activityMetricSourcePresentation(providerId, deviceId, label),
  });
};
const whoopBleSource = whoopBleSourceFor("A050E4D0-67D0-4F4D-9A43-756F7D343DA1");
const secondWhoopBleSource = whoopBleSourceFor("B160F5E1-78E1-50A5-AB54-86708E454EB2");
const whoopBleSources = [whoopBleSource, secondWhoopBleSource];

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
  ...whoopBleSources,
];

it("shows WHOOP with a Peloton delivery badge in the trigger and option", () => {
  const source: ActivityMetricSource = {
    id: "peloton-copy",
    label: "WHOOP via Peloton",
    presentation: {
      displayName: "WHOOP",
      providerId: "whoop",
      sourceName: null,
      attribution: { kind: "provider", providerId: "peloton", label: "Peloton" },
    },
  };
  render(
    <ActivityMetricSourcePicker
      label="Heart Rate"
      sources={[source]}
      selectedId={source.id}
      onChange={() => {}}
    />,
  );
  const trigger = screen.getByRole("button", { name: "Heart Rate source: WHOOP via Peloton" });
  expect(trigger.querySelector('img[src="/logos/whoop.png"]')).toBeTruthy();
  expect(trigger.querySelector('img[src="/logos/peloton.svg"]')).toBeTruthy();
  fireEvent.click(trigger);
  const option = screen.getByRole("radio", { name: "WHOOP via Peloton" }).closest("label");
  expect(option?.querySelector('img[src="/logos/whoop.png"]')).toBeTruthy();
  expect(option?.querySelector('img[src="/logos/peloton.svg"]')).toBeTruthy();
});

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
  it("opens an anchored dropdown with icons and no visible source names", () => {
    render(<PickerHarness />);
    fireEvent.click(screen.getByRole("button", { name: /Heart Rate source/ }));
    const dropdown = screen.getByRole("dialog", { name: "Heart Rate source" });
    expect(dropdown).toHaveAttribute("data-side", "bottom");
    expect(dropdown).not.toHaveAttribute("aria-modal", "true");
    for (const source of sources) {
      const option = screen.getByRole("radio", { name: source.label }).closest("label");
      expect(option?.textContent).toBe("");
      expect(
        option?.querySelector(`[title="${source.presentation.attribution?.label}"]`),
      ).not.toBeNull();
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
    const bluetooth = within(dialog).getByRole("radio", { name: whoopBleSource.label });
    const secondBluetooth = within(dialog).getByRole("radio", {
      name: secondWhoopBleSource.label,
    });
    expect(cloud).toBeChecked();
    expect(bluetooth).not.toBeChecked();
    expect(secondBluetooth).not.toBeChecked();
    await waitFor(() => expect(cloud).toHaveFocus());
    fireEvent.click(bluetooth);
    expect(screen.getByLabelText("Selected recording")).toHaveTextContent(whoopBleSource.id);
    const bluetoothTrigger = screen.getByRole("button", {
      name: `Heart Rate source: ${whoopBleSource.label}`,
    });
    expect(bluetoothTrigger.textContent).toBe("");
    expect(bluetoothTrigger.querySelector('[title="Bluetooth"]')).not.toBeNull();
    await waitFor(() => expect(trigger).toHaveFocus());

    fireEvent.click(bluetoothTrigger);
    const secondBluetoothOption = screen.getByRole("radio", {
      name: secondWhoopBleSource.label,
      checked: false,
    });
    fireEvent.click(secondBluetoothOption);
    expect(screen.getByLabelText("Selected recording")).toHaveTextContent(secondWhoopBleSource.id);
    expect(
      screen.getByRole("button", { name: `Heart Rate source: ${secondWhoopBleSource.label}` }),
    ).not.toHaveTextContent(secondWhoopBleSource.presentation.displayName);
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
      const bluetooth = screen.getByRole("radio", { name: whoopBleSource.label });
      expect(bluetooth).toHaveFocus();
      expect(bluetooth).toBeChecked();
      expect(screen.getByLabelText("Selected recording")).toHaveTextContent(whoopBleSource.id);
      fireEvent.keyDown(bluetooth, { key: "ArrowDown" });
      const secondBluetooth = screen.getByRole("radio", { name: secondWhoopBleSource.label });
      expect(secondBluetooth).toHaveFocus();
      expect(secondBluetooth).toBeChecked();
      expect(screen.getByLabelText("Selected recording")).toHaveTextContent(
        secondWhoopBleSource.id,
      );
      fireEvent.keyDown(secondBluetooth, { key: "ArrowDown" });
      const watch = screen.getByRole("radio", {
        name: "Asher’s Apple Watch (Apple Health)",
      });
      expect(watch).toHaveFocus();
      expect(watch).toBeChecked();
      fireEvent.keyDown(watch, { key: "ArrowUp" });
      expect(secondBluetooth).toHaveFocus();
      expect(secondBluetooth).toBeChecked();
      fireEvent.keyDown(secondBluetooth, { key: "ArrowUp" });
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

  it("retains full provenance in the option tooltip", () => {
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
  });

  it("uses provider icons and keeps complete source descriptions accessible", () => {
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
    expect(strava?.textContent).toBe("");
    expect(strava).toHaveAttribute("title", "Strava · recorded by Peloton Bike");
    expect(strava?.querySelector('img[src="/logos/strava.svg"]')).not.toBeNull();
    expect(
      screen.getByRole("radio", { name: "Imported recording" }).closest("label")?.textContent,
    ).toBe("U");
  });
});
