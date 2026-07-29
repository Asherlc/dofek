import type { Meta, StoryObj } from "@storybook/react-vite";
import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useEffect } from "react";
import { DataConnectionBanner } from "./DataConnectionBanner.tsx";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
    },
  },
});

function OfflineExample() {
  useEffect(() => {
    onlineManager.setOnline(false);
    return () => {
      onlineManager.setOnline(navigator.onLine);
    };
  }, []);

  return <DataConnectionBanner />;
}

const meta = {
  title: "State/DataConnectionBanner",
  component: DataConnectionBanner,
  decorators: [
    (Story) => (
      <QueryClientProvider client={queryClient}>
        <Story />
      </QueryClientProvider>
    ),
  ],
} satisfies Meta<typeof DataConnectionBanner>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Offline: Story = {
  render: () => <OfflineExample />,
};
