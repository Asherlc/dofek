import type { Meta, StoryObj } from "@storybook/react-vite";
import { PasswordInput } from "./PasswordInput.tsx";

const meta = {
  title: "Forms/PasswordInput",
  component: PasswordInput,
  tags: ["autodocs"],
  args: {
    id: "storybook-password",
    visibilityLabel: "password",
    "aria-label": "Password",
    autoComplete: "current-password",
    className:
      "w-full px-3 py-2 text-sm bg-accent/10 border border-border-strong rounded text-foreground focus:outline-none focus:border-accent",
  },
} satisfies Meta<typeof PasswordInput>;

export default meta;

type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const NewPassword: Story = {
  args: {
    id: "storybook-new-password",
    visibilityLabel: "new password",
    "aria-label": "New password",
    autoComplete: "new-password",
    minLength: 8,
    maxLength: 128,
  },
};
