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
});
