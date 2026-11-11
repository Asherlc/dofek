import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type OperationResultObservable, TRPCClientError, type TRPCLink } from "@trpc/client";
import type { AppRouter } from "dofek-server/router";
import { type ReactNode, useMemo } from "react";
import { View } from "react-native";
import { trpc } from "../lib/trpc";
import { ActivityPhotoPreview } from "./ActivityPhotoPreview";
import { activityImageFixture } from "./activity-images-test-helpers";

type Scenario = "photo" | "loading" | "empty" | "error";
function createImageLink(scenario: Scenario): TRPCLink<AppRouter> {
  return () => () => {
    const result: OperationResultObservable<AppRouter, unknown> = {
      subscribe(observer) {
        if (scenario === "error") {
          observer.error?.(new TRPCClientError("Photos could not be loaded. Try again."));
        } else if (scenario !== "loading") {
          observer.next?.({
            result: {
              data: {
                images:
                  scenario === "photo"
                    ? [
                        {
                          ...activityImageFixture,
                          url: "https://images.unsplash.com/photo-1464822759023-fed622ff2c3b?w=1200&q=80",
                        },
                      ]
                    : [],
                coverage: [],
                acquisition: [],
              },
            },
          });
          observer.complete?.();
        }
        return { unsubscribe: () => undefined };
      },
      pipe() {
        return result;
      },
    };
    return result;
  };
}
function Frame({ children, scenario }: { children: ReactNode; scenario: Scenario }) {
  const queryClient = useMemo(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } }),
    [],
  );
  const client = useMemo(
    () => trpc.createClient({ links: [createImageLink(scenario)] }),
    [scenario],
  );
  return (
    <trpc.Provider client={client} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <View style={{ width: 360, maxWidth: "100%" }}>{children}</View>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
const meta = {
  title: "Activities/ActivityPhotoPreview",
  component: ActivityPhotoPreview,
  args: { activityId: "activity-1" },
  decorators: [
    (Story, context) => (
      <Frame scenario={context.parameters.scenario ?? "photo"}>
        <Story />
      </Frame>
    ),
  ],
} satisfies Meta<typeof ActivityPhotoPreview>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Loading: Story = { parameters: { scenario: "loading" } };
export const Empty: Story = { parameters: { scenario: "empty" } };
export const LoadError: Story = { parameters: { scenario: "error" } };
