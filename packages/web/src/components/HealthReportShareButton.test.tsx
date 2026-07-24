/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mutate = vi.fn();
const invalidate = vi.fn(() => Promise.resolve());

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    healthReport: {
      generate: {
        useMutation: (options: {
          onSuccess: (report: { shareToken: string }) => Promise<void>;
        }) => ({
          mutate: (input: unknown) => {
            mutate(input);
            void options.onSuccess({ shareToken: "weekly-token" });
          },
          isPending: false,
          error: null,
        }),
      },
    },
    useUtils: () => ({
      healthReport: {
        myReports: { invalidate },
      },
    }),
  },
}));

import { HealthReportShareButton } from "./HealthReportShareButton.tsx";

describe("HealthReportShareButton", () => {
  beforeEach(() => {
    mutate.mockClear();
    invalidate.mockClear();
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn(() => Promise.resolve()),
      },
    });
  });

  it("generates a weekly report, refreshes the report list, and copies its link", async () => {
    render(
      <HealthReportShareButton
        input={{ reportType: "weekly", weeks: 12, endDate: "2026-07-24" }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Share weekly report" }));

    expect(mutate).toHaveBeenCalledWith({
      reportType: "weekly",
      weeks: 12,
      endDate: "2026-07-24",
    });
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledTimes(1);
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        "http://localhost:3000/health-report?token=weekly-token",
      );
    });
    expect(screen.getByText("Link copied")).toBeTruthy();
  });
});
