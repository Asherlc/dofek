import type { Meta, StoryObj } from "@storybook/react-native";
import { SupportPanel } from "./SupportPanel";

const meta = {
  title: "Components/SupportPanel",
  component: SupportPanel,
  args: {
    onSubmit: (draft) => void draft,
    onReset: () => {},
    isPending: false,
    errorMessage: null,
    ticketId: null,
  },
} satisfies Meta<typeof SupportPanel>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const Sending: Story = {
  args: {
    isPending: true,
  },
};

export const Failed: Story = {
  args: {
    errorMessage: "We couldn't submit your request right now. Please try again shortly.",
  },
};

export const Submitted: Story = {
  args: {
    ticketId: "ticket-1042",
  },
};
