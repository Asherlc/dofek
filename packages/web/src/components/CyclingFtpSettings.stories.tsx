import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type OperationResultObservable, TRPCClientError, type TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { useMemo } from "react";
import { expect, within } from "storybook/test";
import { trpc } from "../lib/trpc.ts";
import { CyclingFtpSettings } from "./CyclingFtpSettings.tsx";

type StoryState = "entered" | "missing" | "loading" | "error" | "suggestions";

const suggestionMethods = [
  {
    method: "reference_curves",
    suggested_ftp: 259,
    evidence: {
      activity_id: "ride-1",
      activity_name: "Threshold intervals",
      date: "2026-11-03",
      duration_seconds: 1200,
      power_watts: 273,
    },
    limitations: "Reference-curve estimate; not a measured threshold.",
    unavailable_reason: null,
  },
  {
    method: "95_percent_best_20_minute",
    suggested_ftp: null,
    evidence: null,
    limitations: "Requires a qualifying 20-minute effort.",
    unavailable_reason: "No qualifying effort in this date range.",
  },
];

function createMockLink(state: StoryState): TRPCLink<AppRouter> {
  return () =>
    ({ op }) => {
      if (op.path === "sportSettings.getBySport") {
        return createMockObservable(
          state,
          state === "missing"
            ? null
            : {
                id: "settings-row",
                sport: "cycling",
                ftp: state === "entered" || state === "suggestions" ? 259 : null,
                effectiveFrom: "2026-10-01",
              },
        );
      }
      if (op.path === "sportSettings.history") {
        return createMockObservable(state, [
          { id: "settings-row", ftp: 259, effectiveFrom: "2026-10-01" },
        ]);
      }
      if (op.path === "power.ftpSuggestions") {
        return createMockObservable(state === "suggestions" ? "entered" : state, {
          methods: suggestionMethods,
        });
      }
      return createMockObservable("entered", {
        id: "settings-row",
        sport: "cycling",
        ftp: op.input && typeof op.input === "object" && "ftp" in op.input ? op.input.ftp : null,
        effectiveFrom: "2026-11-15",
      });
    };
}

function createMockObservable(
  state: StoryState,
  data: unknown,
): OperationResultObservable<AppRouter, unknown> {
  const result: OperationResultObservable<AppRouter, unknown> = {
    subscribe(observer) {
      if (state === "loading") return { unsubscribe: () => {} };
      if (state === "error") {
        observer.error?.(new TRPCClientError<AppRouter>("FTP settings could not be loaded."));
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
}

function CyclingFtpSettingsStoryFrame({ state }: { state: StoryState }) {
  const queryClient = useMemo(() => new QueryClient(), []);
  const trpcClient = useMemo(() => trpc.createClient({ links: [createMockLink(state)] }), [state]);
  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <div className="max-w-2xl p-4">
          <CyclingFtpSettings sectionDate="2026-11-15" focusSection />
        </div>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Settings/CyclingFtpSettings",
  component: CyclingFtpSettings,
  tags: ["autodocs"],
} satisfies Meta<typeof CyclingFtpSettings>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Entered: Story = { render: () => <CyclingFtpSettingsStoryFrame state="entered" /> };
export const Missing: Story = { render: () => <CyclingFtpSettingsStoryFrame state="missing" /> };
export const Loading: Story = { render: () => <CyclingFtpSettingsStoryFrame state="loading" /> };
export const ErrorState: Story = { render: () => <CyclingFtpSettingsStoryFrame state="error" /> };
export const EstimateOptions: Story = {
  render: () => <CyclingFtpSettingsStoryFrame state="suggestions" />,
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Estimate" }));
    await expect(await canvas.findByText("Reference curves")).toBeVisible();
    await expect(canvas.getByRole("status")).toHaveClass("min-h-6");
    await expect(
      canvas.getByText("Unavailable: No qualifying effort in this date range."),
    ).toBeVisible();
  },
};
