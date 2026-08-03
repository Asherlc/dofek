// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RecordsBrowser } from "./provider-detail-data.tsx";

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    providerDetail: {
      availableDataTypes: {
        useQuery: () => ({
          data: ["activities", "sleepSessions"],
          isError: false,
          isLoading: false,
          error: null,
        }),
      },
      recordFilterOptions: {
        useQuery: () => ({ data: {} }),
      },
      records: {
        useQuery: () => ({
          data: { rows: [], columns: [], filterColumns: [] },
          isError: false,
          isLoading: false,
          error: null,
        }),
      },
    },
  },
}));

describe("RecordsBrowser", () => {
  it("exposes record types as tabs with the active type selected", () => {
    render(<RecordsBrowser providerId="wahoo" stats={undefined} />);

    expect(screen.getByRole("tablist", { name: "Record types" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "Activities" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(screen.getByRole("tab", { name: "Sleep" })).toHaveAttribute("aria-selected", "false");
  });
});
