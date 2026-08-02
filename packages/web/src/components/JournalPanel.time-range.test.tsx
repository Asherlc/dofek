/** @vitest-environment jsdom */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearQueryCalls,
  expectCallsContaining,
  expectRegistryCovered,
} from "./test-helpers/TimeRangeSelectorConsumers.tsx";

describe("JournalPanel time range", () => {
  beforeEach(clearQueryCalls);
  afterEach(cleanup);

  it("passes finite and All ranges to log and trends queries", async () => {
    const { JournalPanel } = await import("./JournalPanel.tsx");
    render(<JournalPanel />);

    clearQueryCalls();
    fireEvent.click(screen.getByRole("radio", { name: "7d" }));

    expectCallsContaining([{ name: "journal.entries", input: { days: 7 } }]);
    expectRegistryCovered("journalLog");

    fireEvent.click(screen.getByRole("button", { name: "Trends" }));
    clearQueryCalls();
    fireEvent.click(screen.getByRole("radio", { name: "All" }));

    expectCallsContaining([
      {
        name: "journal.trends",
        input: {
          days: null,
          endDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
        },
      },
    ]);
    expectRegistryCovered("journalTrends");
  });
});
