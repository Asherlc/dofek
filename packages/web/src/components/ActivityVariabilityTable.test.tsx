/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ActivityVariabilityRow } from "dofek-server/types";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityVariabilityTable } from "./ActivityVariabilityTable.tsx";

const mockNavigate = vi.fn();

vi.mock("@tanstack/react-router", () => ({
  useNavigate: () => mockNavigate,
}));

describe("ActivityVariabilityTable", () => {
  beforeEach(() => {
    mockNavigate.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  const rowsWithIds: Array<ActivityVariabilityRow & { activityId: string }> = [
    {
      activityId: "activity-1",
      date: "2026-03-15",
      activityName: "Long Ride",
      normalizedPower: 220,
      averagePower: 200,
      variabilityIndex: 1.1,
      intensityFactor: 0.85,
    },
  ];

  it("navigates to activity detail on row click", () => {
    render(
      <ActivityVariabilityTable
        data={rowsWithIds}
        totalCount={1}
        offset={0}
        limit={20}
        onPageChange={() => {}}
      />,
    );

    const row = screen.getByText("Long Ride").closest("tr");
    if (!row) throw new Error("Row not found");

    fireEvent.click(row);
    expect(mockNavigate).toHaveBeenCalledWith({
      to: "/activity/$id",
      params: { id: "activity-1" },
    });
  });
});
