import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { getQueryKey } from "@trpc/react-query";
import {
  cyclingPowerProfileFixture,
  cyclingPowerProfileWeightRecordFixture,
} from "../../../server/src/contracts/cycling-power-profile-test-fixture.ts";
import { trpc } from "../lib/trpc.ts";
import { CyclingPowerProfile } from "./CyclingPowerProfile.tsx";

const meta = {
  title: "Training/CyclingPowerProfile",
  component: CyclingPowerProfile,
  render: (args) => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    const record = cyclingPowerProfileWeightRecordFixture;
    queryClient.setQueryData(
      getQueryKey(
        trpc.providerDetail.recordDetail,
        {
          providerId: record.provider_id,
          dataType: "bodyMeasurements",
          recordId: record.id,
          responseVersion: 4,
        },
        "query",
      ),
      record,
    );
    const root = createRootRoute({ component: () => <CyclingPowerProfile {...args} /> });
    const activity = createRoute({ getParentRoute: () => root, path: "/activity/$id" });
    const router = createRouter({
      routeTree: root.addChildren([activity]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
    return (
      <trpc.Provider client={trpc.createClient({ links: [] })} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </trpc.Provider>
    );
  },
} satisfies Meta<typeof CyclingPowerProfile>;

export default meta;
type Story = StoryObj<typeof meta>;

export const RecordedEfforts: Story = { args: { profile: cyclingPowerProfileFixture } };
export const Loading: Story = { args: { loading: true } };
export const Empty: Story = {
  args: {
    profile: {
      ...cyclingPowerProfileFixture,
      efforts: cyclingPowerProfileFixture.efforts.map(({ duration_seconds }) => ({
        duration_seconds,
        effort: null,
      })),
      threshold: {
        watts: null,
        watts_per_kg: null,
        weight: null,
        effective_from: null,
        source_record_id: null,
        method: "configured",
        unavailable_reason: "No cycling FTP is configured for the selected end date.",
      },
    },
  },
};
