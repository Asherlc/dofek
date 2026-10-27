/** @vitest-environment jsdom */

import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { ProviderAbsentBanner } from "./ProviderAbsentBanner.tsx";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, params, to }: { children: ReactNode; params: { id: string }; to: string }) => (
    <a href={to.replace("$id", params.id)}>{children}</a>
  ),
}));

describe("ProviderAbsentBanner", () => {
  it("links the provider-specific tombstone to its remediation screen", () => {
    render(
      <ProviderAbsentBanner
        activity={{
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
