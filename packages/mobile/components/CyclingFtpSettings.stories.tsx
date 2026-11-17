import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type OperationResultObservable, TRPCClientError, type TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { type ReactNode, useMemo } from "react";
import { View } from "react-native";
import { expect, within } from "storybook/test";
import { trpc } from "../lib/trpc";
import { CyclingFtpSettings } from "./CyclingFtpSettings";

type StoryState = "entered" | "missing" | "loading" | "error" | "options";

function createStoryClient(state: StoryState) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  const link: TRPCLink<AppRouter> =
    () =>
    ({ op }) => {
      const result: OperationResultObservable<AppRouter, unknown> = {
        subscribe(observer) {
          if (state === "loading" && op.path === "sportSettings.getBySport")
            return { unsubscribe: () => {} };
          if (state === "error" && op.path === "sportSettings.getBySport") {
            observer.error?.(new TRPCClientError("Cycling FTP settings could not be loaded."));
            return { unsubscribe: () => {} };
          }
          let data: unknown;
          if (op.path === "sportSettings.getBySport") {
            data = {
              id: "ftp-setting",
              userId: "story-user",
              sport: "cycling",
              ftp: state === "missing" ? null : 259,
              effectiveFrom: "2026-10-01",
              createdAt: "2026-10-01T12:00:00.000Z",
              updatedAt: "2026-10-01T12:00:00.000Z",
              notes: null,
              thresholdHr: null,
              thresholdPacePerKm: null,
            };
          } else if (op.path === "sportSettings.history") {
            data = [
              {
                id: "ftp-setting",
                userId: "story-user",
                sport: "cycling",
                ftp: 259,
                effectiveFrom: "2026-10-01",
                createdAt: "2026-10-01T12:00:00.000Z",
                updatedAt: "2026-10-01T12:00:00.000Z",
                notes: null,
                thresholdHr: null,
                thresholdPacePerKm: null,
              },
            ];
          } else if (op.path === "power.ftpSuggestions") {
            data = {
              start_date: "2026-08-18",
              end_date: "2026-11-15",
              methods: [
                {
                  method: "reference_curves",
                  suggested_ftp: 259,
                  evidence: {
                    activity_id: "ride-1",
                    activity_name: "Threshold ride",
                    date: "2026-11-03",
                    duration_seconds: 1200,
                    power_watts: 273,
                  },
                  limitations:
                    "An estimate from recorded power; ordinary rides may not be maximal.",
                  unavailable_reason: null,
                },
                {
                  method: "95_percent_best_20_minute",
                  suggested_ftp: null,
                  evidence: null,
                  limitations: "Requires a qualifying 20-minute effort.",
                  unavailable_reason: "No qualifying effort in this date range.",
                },
              ],
            };
          } else if (op.path === "sportSettings.upsert") {
            data = {
              id: "ftp-setting",
              userId: "story-user",
              sport: "cycling",
              ftp: 259,
              effectiveFrom: "2026-11-15",
              createdAt: "2026-11-15T12:00:00.000Z",
              updatedAt: "2026-11-15T12:00:00.000Z",
              notes: null,
              thresholdHr: null,
              thresholdPacePerKm: null,
            };
          } else {
            observer.error?.(new TRPCClientError(`Unhandled FTP story operation: ${op.path}`));
            return { unsubscribe: () => {} };
          }
          observer.next?.({ result: { data } });
          observer.complete?.();
          return { unsubscribe: () => {} };
        },
        pipe() {
          return result;
        },
      };
      return result;
    };
  return { client: trpc.createClient({ links: [link] }), queryClient };
}

function StoryFrame({ state, children }: { state: StoryState; children: ReactNode }) {
  const fixture = useMemo(() => createStoryClient(state), [state]);
  return (
    <trpc.Provider client={fixture.client} queryClient={fixture.queryClient}>
      <QueryClientProvider client={fixture.queryClient}>
        <View style={{ width: "100%", maxWidth: 560, padding: 16 }}>{children}</View>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Settings/CyclingFtpSettings",
  component: CyclingFtpSettings,
  decorators: [
    (Story, context) => {
      const value = context.parameters.ftpState;
      const state: StoryState =
        value === "missing" || value === "loading" || value === "error" || value === "options"
          ? value
          : "entered";
      return (
        <StoryFrame state={state}>
          <Story />
        </StoryFrame>
      );
    },
  ],
} satisfies Meta<typeof CyclingFtpSettings>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Entered: Story = { parameters: { ftpState: "entered" } };
export const Missing: Story = { parameters: { ftpState: "missing" } };
export const Loading: Story = { parameters: { ftpState: "loading" } };
export const ErrorState: Story = { parameters: { ftpState: "error" } };
export const EstimateOptions: Story = {
  parameters: { ftpState: "options" },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Estimate" }));
    await expect(canvas.getByText("Reference curves")).toBeVisible();
    await expect(
      canvas.queryByText("Estimating from recorded activities…"),
    ).not.toBeInTheDocument();
    await expect(canvas.getByText("No qualifying effort in this date range.")).toBeVisible();
  },
};
