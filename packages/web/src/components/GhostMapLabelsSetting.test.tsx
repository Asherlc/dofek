/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import {
  fixtureQuery,
  GhostFixtureProvider,
  ghostError,
  ghostResponse,
} from "./fixtures/ghost-sessions.tsx";
import { GhostMapLabelsSetting } from "./GhostMapLabelsSetting.tsx";

it("defaults to off and grants consent only after the typed setting saves", async () => {
  let enabled = false;
  const fetchResponse = vi.fn<typeof fetch>(async (input, init) => {
    if (fixtureQuery(input).path === "/trpc/settings.set") {
      expect(JSON.parse(String(init?.body))).toEqual({ key: "ghostMapLabels", value: true });
      enabled = true;
      return ghostResponse({ key: "ghostMapLabels", value: true });
    }
    return ghostResponse(enabled ? { key: "ghostMapLabels", value: true } : null);
  });
  render(
    <GhostFixtureProvider fetchResponse={fetchResponse}>
      <GhostMapLabelsSetting />
    </GhostFixtureProvider>,
  );
  const control = await screen.findByRole("checkbox", { name: /show road and trail names/i });
  expect(control).not.toBeChecked();
  expect(control).toHaveAccessibleDescription(
    /recorded GPS coordinates and travel mode with Geoapify/,
  );
  fireEvent.click(control);
  await waitFor(() => expect(control).toBeChecked());
  await waitFor(() => expect(control).toBeEnabled());
  expect(fetchResponse.mock.calls.map(([input]) => fixtureQuery(input).path)).toEqual([
    "/trpc/settings.get",
    "/trpc/settings.set",
    "/trpc/settings.get",
  ]);
});

it("restores the saved consent and shows a local error if withdrawal fails", async () => {
  const fetchResponse: typeof fetch = async (input) =>
    fixtureQuery(input).path === "/trpc/settings.set"
      ? ghostError("INTERNAL_SERVER_ERROR", "Consent was not saved.")
      : ghostResponse({ key: "ghostMapLabels", value: true });
  render(
    <GhostFixtureProvider fetchResponse={fetchResponse}>
      <GhostMapLabelsSetting />
    </GhostFixtureProvider>,
  );
  const control = await screen.findByRole("checkbox", { name: /show road and trail names/i });
  fireEvent.click(control);
  expect(await screen.findByRole("alert")).toHaveTextContent("Consent was not saved.");
  expect(control).toBeChecked();
});
