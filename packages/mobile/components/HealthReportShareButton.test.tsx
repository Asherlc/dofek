/** @vitest-environment jsdom */
import { formatDateMedium } from "@dofek/format/format";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Share } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mutate = vi.fn();
const invalidate = vi.fn(() => Promise.resolve());
const REPORT_EXPIRES_AT = "2026-08-02T12:00:00.000Z";

vi.mock("../lib/auth-context", () => ({
  useAuth: () => ({ serverUrl: "https://dofek.test/" }),
}));

vi.mock("../lib/trpc", () => ({
  trpc: {
    healthReport: {
      generate: {
        useMutation: (options: {
          onSuccess: (report: { shareToken: string; expiresAt: string }) => Promise<void>;
        }) => ({
          mutate: (input: unknown) => {
            mutate(input);
            void options.onSuccess({ shareToken: "monthly-token", expiresAt: REPORT_EXPIRES_AT });
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

import { HealthReportShareButton } from "./HealthReportShareButton";

describe("HealthReportShareButton", () => {
  beforeEach(() => {
    mutate.mockClear();
    invalidate.mockClear();
    vi.mocked(Share.share).mockClear();
  });

  it("defaults to a seven-day expiry, refreshes the report list, and opens native sharing", async () => {
    render(<HealthReportShareButton input={{ reportType: "monthly", months: 6 }} />);

    expect(screen.getByRole("radio", { name: "7 days" }).getAttribute("aria-checked")).toBe("true");

    fireEvent.click(screen.getByRole("button", { name: "Share monthly report" }));

    expect(mutate).toHaveBeenCalledWith({
      reportType: "monthly",
      months: 6,
      expiresInDays: 7,
    });
    const shareUrl = "https://dofek.test/health-report?token=monthly-token";
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledTimes(1);
      expect(Share.share).toHaveBeenCalledWith({
        message: `${shareUrl}\nExpires ${formatDateMedium(REPORT_EXPIRES_AT)}`,
        url: shareUrl,
      });
    });
  });

  it("sends the selected thirty-day expiry to generate", async () => {
    render(<HealthReportShareButton input={{ reportType: "monthly", months: 6 }} />);

    fireEvent.click(screen.getByRole("radio", { name: "30 days" }));
    fireEvent.click(screen.getByRole("button", { name: "Share monthly report" }));

    expect(mutate).toHaveBeenCalledWith({
      reportType: "monthly",
      months: 6,
      expiresInDays: 30,
    });
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalled();
    });
  });

  it("sends the selected ninety-day expiry to generate", async () => {
    render(<HealthReportShareButton input={{ reportType: "monthly", months: 6 }} />);

    fireEvent.click(screen.getByRole("radio", { name: "90 days" }));
    fireEvent.click(screen.getByRole("button", { name: "Share monthly report" }));

    expect(mutate).toHaveBeenCalledWith({
      reportType: "monthly",
      months: 6,
      expiresInDays: 90,
    });
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalled();
    });
  });
});
