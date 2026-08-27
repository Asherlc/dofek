import type { DeveloperClientSecret } from "@dofek/auth/developer-clients";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useEffect } from "react";
import { within } from "storybook/test";
import { DeveloperClientSecretDialog } from "./DeveloperClientSecretDialog.tsx";

const exampleCredential = {
  client: {
    clientId: "ext_example_only",
    name: "Example importer",
    redirectUris: ["https://integration.example/callback"],
    scopes: ["nutrition:write"],
    status: "active",
    createdAt: "2026-08-24T20:00:00.000Z",
    lastRotatedAt: "2026-08-24T20:00:00.000Z",
  },
  clientSecret: "example-placeholder-not-a-real-secret",
} satisfies DeveloperClientSecret;

function ClipboardFailureDialog() {
  useEffect(() => {
    const previous = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.reject(new Error("Example clipboard failure")) },
    });
    return () => {
      if (previous) {
        Object.defineProperty(navigator, "clipboard", previous);
      } else {
        Reflect.deleteProperty(navigator, "clipboard");
      }
    };
  }, []);
  return <DeveloperClientSecretDialog secret={exampleCredential} onDismiss={() => {}} />;
}

const meta = {
  title: "Developer Integrations/DeveloperClientSecretDialog",
  component: DeveloperClientSecretDialog,
  args: {
    secret: exampleCredential,
    onDismiss: () => {},
  },
} satisfies Meta<typeof DeveloperClientSecretDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

export const VisibleOneTimeSecret: Story = {};

export const CopyFailureGuidance: Story = {
  render: () => <ClipboardFailureDialog />,
  play: async ({ canvasElement, userEvent }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(await canvas.findByRole("button", { name: "Copy client secret" }));
    await canvas.findByText("Copy failed. Select and copy the value manually.");
  },
};
