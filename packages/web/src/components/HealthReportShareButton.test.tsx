/** @vitest-environment jsdom */
import { formatDateMedium } from "@dofek/format/format";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mutate = vi.fn();
const invalidate = vi.fn(() => Promise.resolve());
const REPORT_EXPIRES_AT = "2026-08-02T12:00:00.000Z";

vi.mock("../lib/trpc.ts", () => ({
  trpc: {
    healthReport: {
      generate: {
        useMutation: (options: {
          onSuccess: (report: { shareToken: string; expiresAt: string }) => Promise<void>;
        }) => ({
          mutate: (input: unknown) => {
            mutate(input);
            void options.onSuccess({ shareToken: "weekly-token", expiresAt: REPORT_EXPIRES_AT });
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

  it("defaults to a seven-day expiry, refreshes the report list, and copies its link", async () => {
    render(
      <HealthReportShareButton
        input={{ reportType: "weekly", weeks: 12, endDate: "2026-07-24" }}
      />,
    );

    expect(screen.getByRole("radio", { name: "7 days" })).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Share weekly report" }));

    expect(mutate).toHaveBeenCalledWith({
      reportType: "weekly",
      weeks: 12,
      endDate: "2026-07-24",
      expiresInDays: 7,
    });
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledTimes(1);
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
        "http://localhost:3000/health-report?token=weekly-token",
      );
    });
    expect(
      screen.getByText(`Link copied · expires ${formatDateMedium(REPORT_EXPIRES_AT)}`),
    ).toBeTruthy();
  });

  it("sends the selected thirty-day expiry to generate", async () => {
    render(
      <HealthReportShareButton
        input={{ reportType: "weekly", weeks: 12, endDate: "2026-07-24" }}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "30 days" }));
    fireEvent.click(screen.getByRole("button", { name: "Share weekly report" }));

    expect(mutate).toHaveBeenCalledWith({
      reportType: "weekly",
      weeks: 12,
      endDate: "2026-07-24",
      expiresInDays: 30,
    });
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalled();
    });
  });

  it("sends the selected ninety-day expiry to generate", async () => {
    render(
      <HealthReportShareButton
        input={{ reportType: "weekly", weeks: 12, endDate: "2026-07-24" }}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "90 days" }));
    fireEvent.click(screen.getByRole("button", { name: "Share weekly report" }));

    expect(mutate).toHaveBeenCalledWith({
      reportType: "weekly",
      weeks: 12,
      endDate: "2026-07-24",
      expiresInDays: 90,
    });
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalled();
    });
  });

  it("keeps expiry selection independent across share button instances", () => {
    render(
      <>
        <HealthReportShareButton
          input={{ reportType: "weekly", weeks: 12, endDate: "2026-07-24" }}
        />
        <HealthReportShareButton input={{ reportType: "monthly", months: 6 }} />
      </>,
    );

    const thirtyDayOptions = screen.getAllByRole("radio", { name: "30 days" });
    expect(thirtyDayOptions).toHaveLength(2);
    const [firstThirtyDayOption, secondThirtyDayOption] = thirtyDayOptions;
    if (!firstThirtyDayOption || !secondThirtyDayOption) {
      throw new Error("Expected two thirty-day expiry radios");
    }

    fireEvent.click(firstThirtyDayOption);

    expect(firstThirtyDayOption).toBeChecked();
    expect(secondThirtyDayOption).not.toBeChecked();
    expect(screen.getAllByRole("radio", { name: "7 days" })[1]).toBeChecked();
  });
});
