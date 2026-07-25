import type { Meta, StoryObj } from "@storybook/react-vite";
import { ErrorBoundary } from "./ErrorBoundary.tsx";

function BrokenContent(): never {
  throw new Error("The example panel could not be rendered.");
}

const meta = {
  title: "State/ErrorBoundary",
  component: ErrorBoundary,
} satisfies Meta<typeof ErrorBoundary>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    children: <div className="card p-6">Panel content rendered successfully.</div>,
  },
};

export const ErrorState: Story = {
  args: {
    children: <BrokenContent />,
  },
};

export const CustomFallback: Story = {
  args: {
    children: <BrokenContent />,
    fallback: <div className="card p-6 text-red-400">Custom error fallback</div>,
  },
};
