import type { Meta, StoryObj } from "@storybook/react-vite";
import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { within } from "storybook/test";
import { DataConnectionBanner } from "./DataConnectionBanner.tsx";

function useStoryQueryClient() {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
          },
        },
      }),
  );
  return queryClient;
}

function OfflineExample() {
  const queryClient = useStoryQueryClient();

  useEffect(() => {
    onlineManager.setOnline(false);
    return () => {
      onlineManager.setOnline(true);
      queryClient.clear();
    };
  }, [queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <DataConnectionBanner />
    </QueryClientProvider>
  );
}

function OnlineFailureExample({ hangOnRetry = false }: { hangOnRetry?: boolean }) {
  const queryClient = useStoryQueryClient();

  useEffect(() => {
    onlineManager.setOnline(true);
    let attempt = 0;
    const observer = new QueryObserver(queryClient, {
      queryKey: ["storybook", hangOnRetry ? "retrying" : "failed"],
      initialData: { score: 82 },
      staleTime: 0,
      queryFn: () => {
        attempt += 1;
        if (hangOnRetry && attempt > 1) {
          return new Promise<{ score: number }>(() => undefined);
        }
        return Promise.reject(new Error("Server unavailable"));
      },
    });
    const unsubscribe = observer.subscribe(() => undefined);

    return () => {
      unsubscribe();
      queryClient.clear();
      onlineManager.setOnline(true);
    };
  }, [hangOnRetry, queryClient]);

  return (
    <QueryClientProvider client={queryClient}>
      <DataConnectionBanner />
    </QueryClientProvider>
  );
}

const meta = {
  title: "State/DataConnectionBanner",
  component: DataConnectionBanner,
} satisfies Meta<typeof DataConnectionBanner>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Offline: Story = {
  render: () => <OfflineExample />,
};

export const OnlineFailure: Story = {
  render: () => <OnlineFailureExample />,
};

export const Retrying: Story = {
  render: () => <OnlineFailureExample hangOnRetry />,
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Retry" }));
    await canvas.findByRole("button", { name: "Retrying..." });
  },
};
