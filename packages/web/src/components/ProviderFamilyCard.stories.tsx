import type { Meta, StoryObj } from "@storybook/react";
import { ProviderFamilyCard } from "./ProviderFamilyCard.tsx";

const meta = {
  title: "Providers/ProviderFamilyCard",
  component: ProviderFamilyCard,
} satisfies Meta<typeof ProviderFamilyCard>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Garmin: Story = {
  args: {
    familyLabel: "Garmin",
    methods: [
      { id: "garmin", label: "Garmin Connect", content: <div>Connect Garmin</div> },
      { id: "garmin-dump", label: "Data export", content: <div>Import Garmin export</div> },
    ],
  },
};

export const GarminExport: Story = {
  args: {
    ...Garmin.args,
    initialMethodId: "garmin-dump",
  },
};
