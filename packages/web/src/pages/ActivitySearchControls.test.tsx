/** @vitest-environment jsdom */

import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ActivitySearchControls } from "./ActivitySearchControls.tsx";

const lookup = vi.hoisted(() => vi.fn());

vi.mock("../lib/trpc.ts", () => ({
  trpc: { activityLocation: { places: { useQuery: lookup } } },
}));

beforeEach(() => {
  lookup.mockReset();
  lookup.mockReturnValue({});
});

it("searches a recorded name and lets the user choose a qualified public place", () => {
  lookup.mockImplementation((_input, options) =>
    options.enabled
      ? {
          data: [
            { id: "ca", label: "Oakland, CA", latitude: 37.8, longitude: -122.3 },
            { id: "or", label: "Oakland, OR", latitude: 43.4, longitude: -123.3 },
          ],
        }
      : {},
  );
  const onSearch = vi.fn();
  render(<ActivitySearchControls selection={undefined} onSearch={onSearch} />);
  fireEvent.click(screen.getByRole("button", { name: "Location" }));
  fireEvent.change(screen.getByRole("searchbox", { name: "Search activity locations" }), {
    target: { value: " Oakland " },
  });
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  expect(onSearch).toHaveBeenLastCalledWith({ kind: "name", name: "Oakland" });
  expect(lookup.mock.lastCall?.[1].enabled).toBe(false);

  fireEvent.click(screen.getByRole("button", { name: "Look up a place" }));
  expect(lookup).toHaveBeenLastCalledWith(
    { query: "Oakland" },
    expect.objectContaining({ enabled: true }),
  );
  expect(screen.getByRole("button", { name: "Oakland, CA" })).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Oakland, OR" }));
  expect(onSearch).toHaveBeenLastCalledWith({
    kind: "nearby",
    latitude: 43.4,
    longitude: -123.3,
    label: "Oakland, OR",
  });
  expect(screen.queryByRole("button", { name: "Oakland, CA" })).toBeNull();
});

it("keeps named matches usable when place lookup fails", () => {
  const refetch = vi.fn();
  lookup.mockImplementation((_input, options) =>
    options.enabled
      ? { isError: true, error: new Error("Place lookup is temporarily unavailable."), refetch }
      : {},
  );
  const onSearch = vi.fn();
  render(<ActivitySearchControls selection={undefined} onSearch={onSearch} />);
  fireEvent.click(screen.getByRole("button", { name: "Location" }));
  fireEvent.change(screen.getByRole("searchbox"), { target: { value: "East Bay" } });
  fireEvent.click(screen.getByRole("button", { name: "Look up a place" }));
  expect(screen.getByText("Place lookup is temporarily unavailable.")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Retry place lookup" }));
  expect(refetch).toHaveBeenCalledOnce();
  fireEvent.click(screen.getByRole("button", { name: "Search" }));
  expect(onSearch).toHaveBeenLastCalledWith({ kind: "name", name: "East Bay" });
});
