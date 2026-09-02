// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Route } from "./privacy.tsx";

afterEach(cleanup);

describe("PrivacyPage", () => {
  it("accurately identifies every production data store", () => {
    const PrivacyPage = Route.options.component;
    if (!PrivacyPage) {
      throw new Error("Privacy route is missing its page component");
    }

    render(<PrivacyPage />);

    expect(screen.getByText("Last updated: July 29, 2026")).toBeInTheDocument();
    expect(screen.getByText(/PostgreSQL \(TimescaleDB\)/)).toBeInTheDocument();
    expect(screen.getByText(/ClickHouse/)).toBeInTheDocument();
    expect(screen.getByText(/Redpanda/)).toBeInTheDocument();
    expect(screen.getByText(/Cloudflare R2/)).toBeInTheDocument();
    expect(screen.getByText(/Redis/)).toBeInTheDocument();
    expect(screen.queryByText(/All data is stored in .*PostgreSQL/)).not.toBeInTheDocument();
  });

  it("states the staged deletion boundaries without claiming OS-owned data deletion", () => {
    const PrivacyPage = Route.options.component;
    if (!PrivacyPage) throw new Error("Privacy route is missing its page component");

    render(<PrivacyPage />);

    expect(
      screen.getByText(
        /verifies its active application stores after the seven-day replay window has elapsed/i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Final retained-data verification is due no later than 30 days/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/HealthKit and Core Motion source records remain controlled by iOS/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/retains an immutable encrypted deletion-ledger record indefinitely/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/does not contain a raw account or provider identifier, email address/i),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: /track an account deletion request/i }),
    ).toHaveAttribute("href", "/account-deletion");
    expect(screen.getByRole("link", { name: /contact the Dofek administrator/i })).toHaveAttribute(
      "href",
      "mailto:asherlc@asherlc.com",
    );
  });

  it("does not contradict the disclosed processor sharing in the Garmin section", () => {
    const PrivacyPage = Route.options.component;
    if (!PrivacyPage) throw new Error("Privacy route is missing its page component");

    render(<PrivacyPage />);

    expect(
      screen.getByText(
        /Garmin data is not sold and is disclosed only to the service providers described above/i,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/never sold or shared with third parties/i)).not.toBeInTheDocument();
  });
});
