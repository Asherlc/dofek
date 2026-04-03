import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { trpc } from "../lib/trpc";
import ActivitiesScreen from "./activities";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
});

const trpcClient = trpc.createClient({
  links: [httpBatchLink({ url: "http://localhost:0/api/trpc" })],
});

function MockProviders({ children }: { children: React.ReactNode }) {
  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </trpc.Provider>
  );
}

const meta = {
  title: "Pages/Activities",
  component: ActivitiesScreen,
  decorators: [
    (Story) => (
      <MockProviders>
        <View style={{ flex: 1, backgroundColor: "#000" }}>
          <Story />
        </View>
      </MockProviders>
    ),
  ],
} satisfies Meta<typeof ActivitiesScreen>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};
