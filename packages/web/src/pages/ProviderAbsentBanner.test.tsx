/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderAbsentBanner } from "./ProviderAbsentBanner.tsx";

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  invalidate: vi.fn(),
  pending: false,
  showError: false,
  error: new Error("Provider connection is unavailable"),
  captureException: vi.fn(),
}));

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    useUtils: () => ({
      activity: { invalidate: mocks.invalidate },
      calendar: {
        weekListV2: { invalidate: mocks.invalidate },
        activityOverview: { invalidate: mocks.invalidate },
        calendarData: { invalidate: mocks.invalidate },
      },
    }),
    activity: {
      restoreProviderAbsent: {
        useMutation: (options: {
          onSuccess: () => Promise<void>;
          onError: (error: Error) => void;
        }) => ({
          mutate: (input: { ids: string[] }) => {
            mocks.mutate(input);
            if (mocks.showError) options.onError(mocks.error);
            else void options.onSuccess();
          },
          isPending: mocks.pending,
          error: mocks.showError ? mocks.error : null,
          reset: vi.fn(),
        }),
      },
    },
  },
}));

vi.mock("../lib/telemetry.ts", () => ({ captureException: mocks.captureException }));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, params, to }: { children: ReactNode; params: { id: string }; to: string }) => (
    <a href={to.replace("$id", params.id)}>{children}</a>
  ),
}));

describe("ProviderAbsentBanner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pending = false;
    mocks.showError = false;
  });
  afterEach(() => cleanup());

  it("restores this activity and refreshes the activity detail, list, and calendar", async () => {
    render(
      <ProviderAbsentBanner
        activity={{
          id: "activity-1",
          providerId: "strava",
          subsource: null,
          providerAbsentAt: "2026-03-05T14:30:00.000Z",
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Restore activity" }));

    expect(mocks.mutate).toHaveBeenCalledWith({ ids: ["activity-1"] });
    expect(mocks.invalidate).toHaveBeenCalledTimes(4);
    expect(mocks.invalidate).toHaveBeenCalledWith();
  });

  it("disables the restore action while the request is pending", () => {
    mocks.pending = true;
    render(
      <ProviderAbsentBanner
        activity={{
          id: "activity-1",
          providerId: "strava",
          subsource: null,
          providerAbsentAt: null,
        }}
      />,
    );

    expect(screen.getByRole("button", { name: "Restoring…" })).toBeDisabled();
  });

  it("shows the server error and allows retry", () => {
    mocks.showError = true;
    render(
      <ProviderAbsentBanner
        activity={{
          id: "activity-1",
          providerId: "strava",
          subsource: null,
          providerAbsentAt: null,
        }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Restore activity" }));

    expect(screen.getByRole("alert")).toHaveTextContent("Provider connection is unavailable");
    expect(mocks.captureException).toHaveBeenCalledWith(mocks.error, {
      context: "activity-restore",
    });
  });

  it("links the provider-specific tombstone to its remediation screen", () => {
    render(
      <ProviderAbsentBanner
        activity={{
          id: "activity-2",
          providerId: "strava",
          subsource: null,
          providerAbsentAt: "2026-03-05T14:30:00.000Z",
        }}
      />,
    );

    const link = screen.getByRole("link", { name: "Review Strava connection" });
    expect(link.getAttribute("href")).toBe("/providers/strava");
  });

  it("labels Apple Health remediation links with the destination provider", () => {
    render(
      <ProviderAbsentBanner
        activity={{
          id: "activity-3",
          providerId: "apple_health",
          subsource: "Strava",
          providerAbsentAt: "2026-03-05T14:30:00.000Z",
        }}
      />,
    );

    const link = screen.getByRole("link", { name: "Review Apple Health connection" });
    expect(link.getAttribute("href")).toBe("/providers/apple_health");
  });
});
