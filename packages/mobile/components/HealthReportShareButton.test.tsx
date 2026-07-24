/** @vitest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { Share } from "react-native";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mutate = vi.fn();
const invalidate = vi.fn(() => Promise.resolve());

vi.mock("../lib/auth-context", () => ({
  useAuth: () => ({ serverUrl: "https://dofek.test/" }),
}));

vi.mock("../lib/trpc", () => ({
  trpc: {
    healthReport: {
      generate: {
        useMutation: (options: {
          onSuccess: (report: { shareToken: string }) => Promise<void>;
        }) => ({
          mutate: (input: unknown) => {
            mutate(input);
            void options.onSuccess({ shareToken: "monthly-token" });
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

  it("generates a monthly report, refreshes the report list, and opens native sharing", async () => {
    render(<HealthReportShareButton input={{ reportType: "monthly", months: 6 }} />);

    fireEvent.click(screen.getByRole("button", { name: "Share monthly report" }));

    expect(mutate).toHaveBeenCalledWith({ reportType: "monthly", months: 6 });
    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledTimes(1);
      expect(Share.share).toHaveBeenCalledWith({
        message: "https://dofek.test/health-report?token=monthly-token",
        url: "https://dofek.test/health-report?token=monthly-token",
      });
    });
  });
});
