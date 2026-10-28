import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { getQueryKey } from "@trpc/react-query";
import { View } from "react-native";
import { expect, within } from "storybook/test";
import { trpc } from "../lib/trpc";
import { TrainingVolumeChart } from "./TrainingVolumeChart";

const meta = {
  title: "Training/TrainingVolumeChart",
  component: TrainingVolumeChart,
  args: {
    sport: "climbing",
    data: [
      { week: "2026-10-05", attempts: 8, minutes: 35 },
      { week: "2026-10-12", attempts: 12, minutes: 45 },
      { week: "2026-10-19", attempts: 10, minutes: 55 },
    ],
  },
  decorators: [
    (Story) => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } },
      });
      queryClient.setQueryData(getQueryKey(trpc.settings.get, { key: "unitSystem" }, "query"), {
        value: "metric",
      });
      const client = trpc.createClient({ links: [httpBatchLink({ url: "/api/trpc" })] });
      return (
        <trpc.Provider client={client} queryClient={queryClient}>
          <QueryClientProvider client={queryClient}>
            <View style={{ width: "100%", maxWidth: 560 }}>
              <Story />
            </View>
          </QueryClientProvider>
        </trpc.Provider>
      );
    },
  ],
} satisfies Meta<typeof TrainingVolumeChart>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Empty: Story = { args: { data: [] } };

export const MissingAndZero: Story = {
  args: {
    data: [
      { week: "2026-10-05", attempts: 8, minutes: 35 },
      { week: "2026-10-12", attempts: 0, minutes: 0 },
      { week: "2026-10-19", attempts: null, minutes: null },
    ],
  },
};

export const Minutes: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("radio", { name: "Time" }));
    await expect(canvas.getByText("minutes per week")).toBeVisible();
    await expect(canvas.getByLabelText("2026-10-12: 45 minutes")).toBeVisible();
  },
};

export const HoursMinutes: Story = {
  args: {
    data: [
      { week: "2026-09-21", attempts: 18, minutes: 600 },
      { week: "2026-09-28", attempts: 12, minutes: 60 },
      { week: "2026-10-05", attempts: 8, minutes: 45 },
      { week: "2026-10-12", attempts: 0, minutes: 0 },
      { week: "2026-10-19", attempts: null, minutes: null },
    ],
  },
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    const time = await canvas.findByRole("radio", { name: "Time" });
    await userEvent.click(time);
    await expect(time).toHaveAttribute("aria-checked", "true");
    await expect(canvas.getByText("hours:minutes per week")).toBeVisible();
    await expect(canvas.getByLabelText("2026-09-21: 10:00 h:mm")).toBeVisible();
    await expect(canvas.getByLabelText("2026-09-28: 1:00 h:mm")).toBeVisible();
    await expect(canvas.getByLabelText("2026-10-05: 0:45 h:mm")).toBeVisible();
    await expect(canvas.getByLabelText("2026-10-12: 0:00 h:mm")).toBeVisible();
    await expect(canvas.getByLabelText("2026-10-19: Not recorded")).toBeVisible();
  },
};
