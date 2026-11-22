import { UnitConverter } from "@dofek/format/units";
import type { Meta, StoryObj } from "@storybook/react-native";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { getQueryKey } from "@trpc/react-query";
import {
  cyclingPowerProfileFixture,
  cyclingPowerProfileWeightRecordFixture,
} from "../../server/src/contracts/cycling-power-profile-test-fixture";
import { trpc } from "../lib/trpc";
import { CyclingPowerProfile } from "./CyclingPowerProfile";

const meta = {
  title: "Training/CyclingPowerProfile",
  component: CyclingPowerProfile,
  args: { units: new UnitConverter("metric") },
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
    return (
      <trpc.Provider client={trpc.createClient({ links: [] })} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <CyclingPowerProfile {...args} />
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
