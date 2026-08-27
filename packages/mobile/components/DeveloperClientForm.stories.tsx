import type { Meta, StoryObj } from "@storybook/react-native";
import { View } from "react-native";
import { within } from "storybook/test";
import { DeveloperClientForm } from "./DeveloperClientForm";

const meta = {
  title: "Developer Integrations/DeveloperClientForm",
  component: DeveloperClientForm,
  args: { onSubmit: () => {} },
  decorators: [
    (Story) => (
      <View style={{ padding: 16, width: 360 }}>
        <Story />
      </View>
    ),
  ],
} satisfies Meta<typeof DeveloperClientForm>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const ValidationError: Story = {
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByRole("textbox", { name: "Integration name" }), "Importer");
    await userEvent.type(
      canvas.getByRole("textbox", { name: "Redirect URI 1" }),
      "http://integration.example/callback",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Create integration" }));
  },
};

export const Submitting: Story = { args: { isSubmitting: true } };
