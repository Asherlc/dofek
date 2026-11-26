import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { fn } from "storybook/test";
import { colors } from "../theme";
import {
  BillingPurchaseLegalLinks,
  BillingPurchaseProductSummary,
  BillingSubscribeButton,
  DOFEK_PREMIUM_MONTHLY_TITLE,
} from "./BillingPurchaseLegalLinks";

const meta = {
  title: "Components/BillingPurchaseLegalLinks",
  component: BillingPurchaseLegalLinks,
  args: {
    privacyPolicyUrl: "https://dofek.fit/privacy",
    onError: fn(),
  },
  decorators: [
    (Story) => (
      <View style={{ padding: 16, backgroundColor: colors.background }}>
        <Story />
      </View>
    ),
  ],
} satisfies Meta<typeof BillingPurchaseLegalLinks>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const WithProductSummary: Story = {
  render: (args) => (
    <View>
      <BillingPurchaseProductSummary
        productTitle={DOFEK_PREMIUM_MONTHLY_TITLE}
        productLoading={false}
        priceUnavailable={false}
      />
      <BillingSubscribeButton
        displayPrice="$4.99"
        isSubscribing={false}
        disabled={false}
        onPress={fn()}
      />
      <BillingPurchaseLegalLinks {...args} />
    </View>
  ),
};

export const LoadingPrice: Story = {
  render: (args) => (
    <View>
      <BillingPurchaseProductSummary
        productTitle={DOFEK_PREMIUM_MONTHLY_TITLE}
        productLoading
        priceUnavailable={false}
      />
      <BillingPurchaseLegalLinks {...args} />
    </View>
  ),
};

export const PriceUnavailable: Story = {
  render: (args) => (
    <View>
      <BillingPurchaseProductSummary
        productTitle={DOFEK_PREMIUM_MONTHLY_TITLE}
        productLoading={false}
        priceUnavailable
      />
      <BillingPurchaseLegalLinks {...args} />
    </View>
  ),
};
