import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { View } from "react-native";
import { trpc } from "../lib/trpc";
import { GoalWeightSettingsSection } from "./GoalWeightSettingsSection";

const meta = {
  title: "Settings/GoalWeightSettingsSection",
  component: GoalWeightSettingsSection,
  args: { unitSystem: "metric" },
  decorators: [
    (Story, context) => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { staleTime: Number.POSITIVE_INFINITY, retry: false } },
      });
      queryClient.setQueryData(
        [["settings", "get"], { input: { key: "goalWeight" }, type: "query" }],
        context.parameters.empty ? null : { value: "75" },
      );
      const client = trpc.createClient({ links: [httpBatchLink({ url: "/api/trpc" })] });
      return (
        <trpc.Provider client={client} queryClient={queryClient}>
          <QueryClientProvider client={queryClient}>
            <View style={{ padding: 16 }}>
              <Story />
            </View>
          </QueryClientProvider>
        </trpc.Provider>
      );
    },
  ],
} satisfies Meta<typeof GoalWeightSettingsSection>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Empty: Story = { parameters: { empty: true } };
export const Imperial: Story = { args: { unitSystem: "imperial" } };
